import { unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

// Keep socket paths short enough for macOS sockaddr_un.
const directory = process.platform === "win32" ? null : `/tmp/texvu-${process.getuid()}`;

async function socketPrefix(pdf) {
  const hash = createHash("sha256").update(await fs.realpath(pdf)).digest("hex").slice(0, 32);
  return `pdf-${hash}-`;
}

async function privateDirectory() {
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Expected a private socket directory at ${directory}`);
  }
}

export async function listenForJumps(pdf, handler) {
  const prefix = await socketPrefix(pdf);
  // Each process owns its socket. A crashed viewer cannot block a restart.
  const name = prefix + randomUUID();
  if (directory) await privateDirectory();
  const address = directory ? path.join(directory, name) : path.win32.join("\\\\.\\pipe", name);
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  if (directory) {
    const cleanup = () => {
      try { unlinkSync(address); } catch (error) { if (error.code !== "ENOENT") throw error; }
    };
    process.once("exit", cleanup);
    server.once("close", () => process.removeListener("exit", cleanup));
  }
  return server;
}

function request(socketPath, method, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: "/jump", agent: false }, async res => {
      try {
        let text = "";
        for await (const chunk of res) text += chunk;
        const result = JSON.parse(text);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Viewer timed out")));
    req.end(body && JSON.stringify(body));
  });
}

export async function jump(pdf, source, line, column) {
  const prefix = await socketPrefix(pdf);
  if (directory) await privateDirectory();
  const root = directory ?? "\\\\.\\pipe";
  const candidates = (await fs.readdir(root)).filter(name => name.startsWith(prefix));
  const servers = [];
  for (const name of candidates) {
    const socket = path.join(root, name);
    try {
      const { lastFocus } = await request(socket, "GET");
      servers.push({ socket, lastFocus });
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      if (directory && error.code === "ECONNREFUSED") {
        await fs.rm(socket, { force: true });
      }
    }
  }
  if (!servers.length) throw new Error(`No server running for ${pdf}. Start texvu with that PDF first.`);
  const [target] = servers.sort((a, b) => (b.lastFocus ?? -1) - (a.lastFocus ?? -1));
  await request(target.socket, "POST", { source: path.resolve(source), line, column });
}
