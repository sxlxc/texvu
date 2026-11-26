import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 4173;
export const DEFAULT_HOST = "127.0.0.1";

async function controlAddress(host, port) {
  const key = createHash("sha256").update(JSON.stringify([os.homedir(), host, port])).digest("hex").slice(0, 24);
  if (process.platform === "win32") return path.win32.join("\\\\.\\pipe", "texvu-" + key);
  const dir = `/tmp/texvu-${process.getuid()}`;
  await fs.mkdir(dir, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Expected a private socket directory at ${dir}`);
  }
  return path.join(dir, key + ".sock");
}

export async function listenForCommands(host, port, handler) {
  const address = await controlAddress(host, port);
  // The caller already owns the HTTP listener for this endpoint.
  if (process.platform !== "win32") await fs.rm(address, { force: true });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once("error", reject).listen(address, resolve));
  return server;
}

export async function command(host, port, action, body) {
  const socketPath = await controlAddress(host, port);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: "POST", path: "/" + action, agent: false }, async res => {
      try {
        let text = "";
        for await (const chunk of res) text += chunk;
        const result = JSON.parse(text);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
    req.on("error", error => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) {
        reject(new Error(`No texvu daemon for ${host}:${port}. Run "brew services start texvu" or start "texvu daemon" with the same host and port.`));
      } else reject(error);
    });
    req.setTimeout(15000, () => req.destroy(new Error("Viewer timed out")));
    req.end(JSON.stringify(body));
  });
}
