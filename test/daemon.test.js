import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";

test("persistent documents, isolated reloads and most-recent-tab jumps", { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "texvu-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = String(listener.address().port);
  await new Promise(resolve => listener.close(resolve));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env = { ...process.env, XDG_STATE_HOME: dir };
  const run = async (...args) => (await promisify(execFile)(process.execPath, [cli, ...args, "--port", port], { env })).stdout.trim();
  let daemon;
  async function start() {
    daemon = spawn(process.execPath, [cli, "daemon", "--port", port], { env, stdio: ["ignore", "pipe", "inherit"] });
    await Promise.race([once(daemon.stdout, "data"), once(daemon, "exit").then(([code]) => { throw new Error("Daemon exited: " + code); })]);
  }
  async function stop() {
    if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
    const exit = once(daemon, "exit");
    daemon.kill();
    await exit;
  }
  t.after(stop);
  const pdfA = path.join(dir, "a", "main.pdf");
  const pdfB = path.join(dir, "b", "main.pdf");
  for (const pdf of [pdfA, pdfB]) {
    await fs.mkdir(path.dirname(pdf));
    await fs.writeFile(pdf, "%PDF " + pdf);
  }
  await fs.writeFile(path.join(dir, "a", ".pdfjs-synctex.json"), JSON.stringify({
    synctexCommand: process.execPath, synctexForwardArgs: ["-e", "console.log('Page: 2\\nx: 3\\ny: 4')"],
  }));
  await start();
  const [a, b] = await Promise.all([pdfA, pdfB].map(pdf => run("--no-open", pdf)));
  assert.notEqual(a, b);
  const alias = path.join(dir, "alias.pdf");
  await fs.symlink(pdfA, alias);
  assert.equal(await run("--no-open", alias), a);
  const pdfUrl = viewer => new URL(new URL(viewer).searchParams.get("file"), viewer);
  assert.match(await (await fetch(a)).text(), /rel="icon"[^>]+base64,/);
  const range = await fetch(pdfUrl(b), { headers: { Range: "bytes=0-3" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "%PDF");

  const tabs = [];
  async function connect(viewer) {
    const url = new URL("events", pdfUrl(viewer));
    url.protocol = "ws:";
    url.searchParams.set("tab", "1-2-3-" + tabs.length);
    const socket = new WebSocket(url);
    const messages = [];
    socket.on("message", data => messages.push(JSON.parse(data)));
    tabs.push({ socket, messages });
    await once(socket, "open");
    return tabs.at(-1);
  }
  const first = await connect(a);
  const selected = await connect(a);
  const others = [];
  for (let i = 0; i < 7; i++) others.push(await connect(b));
  selected.socket.send("focus");
  // A pong acknowledges all earlier frames on this connection.
  selected.socket.ping();
  await once(selected.socket, "pong");
  others[0].socket.send("focus");
  const jumped = once(selected.socket, "message");
  await run("jump", "--no-focus", pdfA, "main.tex", "1");
  await jumped;
  assert.deepEqual(selected.messages, [{ type: "forward-search", data: { page: 2, x: 3, y: 4 } }]);
  assert.deepEqual(first.messages, []);
  const reloads = [first, selected].map(({ socket }) => once(socket, "message"));
  await fs.writeFile(pdfA + ".tmp", "%PDF rebuilt");
  await fs.rename(pdfA + ".tmp", pdfA);
  await Promise.all(reloads);
  assert.equal(first.messages.at(-1).type, "pdf-changed");
  assert.equal(selected.messages.at(-1).type, "pdf-changed");
  assert(others.every(tab => !tab.messages.length));
  await Promise.all(tabs.map(async ({ socket }) => {
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }));
  await assert.rejects(run("jump", pdfA, "main.tex", "1"), /No viewer open/);
  await stop();
  await start();
  assert.equal(await (await fetch(pdfUrl(a))).text(), "%PDF rebuilt");
  assert.equal(await run("--no-open", pdfA), a);
});
