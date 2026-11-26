import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { listenForCommands } from "./jump.js";
import { DEFAULT_SETTINGS, findSyncTexPath, forwardSearch, inverseSearch, openEditor } from "./synctex.js";

const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vendor/pdfjs");
const CONFIG_FILE = ".pdfjs-synctex.json";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".ftl": "text/plain; charset=utf-8",
};

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function sendError(response, status, error) {
  sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
}

function requireNumber(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw Object.assign(new Error(`${label} must be a number greater than or equal to ${minimum}`), { statusCode: 400 });
  return number;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
}

function isStringArray(value) {
  return Array.isArray(value) && value.length <= 32 && value.every(item => typeof item === "string" && item.length <= 1000);
}

function normalizeSettings(value) {
  const candidate = value && typeof value === "object" ? value : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of ["synctexCommand", "editorCommand"]) {
    if (typeof candidate[key] === "string" && candidate[key].length > 0 && candidate[key].length < 300) settings[key] = candidate[key];
  }
  for (const key of ["synctexForwardArgs", "synctexInverseArgs", "editorArgs"]) {
    if (isStringArray(candidate[key])) settings[key] = candidate[key];
  }
  return settings;
}

async function loadSettings(pdfPath) {
  try {
    const raw = await fsp.readFile(path.join(path.dirname(pdfPath), CONFIG_FILE), "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(pdfPath, settings) {
  const file = path.join(path.dirname(pdfPath), CONFIG_FILE);
  const temp = file + "." + randomUUID();
  try {
    await fsp.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", error => console.error(`Could not open the browser: ${error.message}. Open the viewer URL above.`));
  child.unref();
}

const runFile = promisify(execFile);
const focusScript = fileURLToPath(new URL("./focus-tab.jxa", import.meta.url));

const firefoxScript = fileURLToPath(new URL("./focus-firefox.jxa", import.meta.url));

async function focusFirefox(tab) {
  // A separate Firefox profile can run as a separate macOS application instance.
  const socket = tab.socket;
  if (!socket) return "The Firefox viewer disconnected.";
  if (!tab.firefoxPid && socket.remoteAddress === socket.localAddress) {
    const { stdout } = await runFile("/usr/sbin/lsof", ["-nP", "-iTCP:" + socket.localPort, "-sTCP:ESTABLISHED", "-Fpn"], { timeout: 1000 }).catch(() => ({ stdout: "" }));
    let pid;
    for (const field of stdout.split("\n")) {
      if (field.startsWith("p")) pid = field.slice(1);
      if (field.startsWith("n") && field.includes(":" + socket.remotePort + "->") && field.endsWith(":" + socket.localPort)) tab.firefoxPid = pid;
    }
  }
  const run = mode => runFile("/usr/bin/osascript", ["-l", "JavaScript", firefoxScript, mode, tab.id, tab.firefoxPid ?? ""], { timeout: 3500, killSignal: "SIGKILL" });
  const probe = async () => {
    const since = performance.now();
    tab.send("focus-probe");
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      if (tab.lastFocus >= since) return true;
    }
    return false;
  };
  await run("raise");
  if (await probe()) return;
  tab.send("mark-tab");
  try {
    const { stdout } = await run("select");
    if (stdout.trim() === "permission") return "To select a background Firefox tab, allow Accessibility for the app running the texvu server in macOS System Settings.";
    if (await probe()) return;
    return "Firefox could not select the viewer tab.";
  } finally {
    tab.send("unmark-tab");
  }
}

async function focusTab(tab) {
  const { id, agent } = tab;
  if (process.platform !== "darwin" || !/^\d+(?:-\d+){3}$/.test(id)) return;
  let browser;
  if (/Chrome\//.test(agent)) browser = "com.google.Chrome";
  else if (/Version\/.*Safari\//.test(agent)) browser = "com.apple.Safari";
  try {
    if (/Firefox\//.test(agent)) return await focusFirefox(tab);
    if (!browser) return;
    const { stdout } = await runFile("/usr/bin/osascript", ["-l", "JavaScript", focusScript, browser, id], { timeout: 4000, killSignal: "SIGKILL" });
    if (stdout.trim() === "focused") return;
    return "The browser could not locate the viewer tab.";
  } catch (error) {
    return `Browser activation failed: ${error.stderr?.trim() || error.message}`;
  }
}

function safeStaticPath(root, requestPath) {
  const filePath = path.resolve(root, `.${requestPath}`);
  return filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
}

async function serveFile(request, response, filePath, contentType) {
  const file = await fsp.open(filePath);
  let stream;
  try {
    const { size } = await file.stat();
    const range = request.headers.range;
    let start = 0;
    let end = size - 1;
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "no-cache");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) throw Object.assign(new Error("Invalid range"), { statusCode: 416 });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
      if (start > end) throw Object.assign(new Error("Range not satisfiable"), { statusCode: 416 });
      response.setHeader("content-range", `bytes ${start}-${end}/${size}`);
    }
    response.writeHead(range ? 206 : 200, { "content-length": end - start + 1 });
    if (request.method === "HEAD" || !size || response.destroyed) return response.end();
    stream = file.createReadStream({ start, end });
    response.once("close", () => stream.destroy());
    stream.on("error", error => response.destroy(error)).pipe(response);
  } finally {
    if (!stream) await file.close();
  }
}

const stateDirectory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "texvu", "documents");
const documentId = pdf => createHash("sha256").update(pdf).digest("hex");
const viewerPath = id => `/web/viewer.html?file=${encodeURIComponent(`/d/${id}/pdf`)}`;

async function registeredPath(registry, id) {
  try {
    return await fsp.readFile(path.join(registry, id), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") error.statusCode = 404;
    throw error;
  }
}

async function register(registry, pdfPath, id) {
  const file = path.join(registry, id);
  await fsp.mkdir(registry, { mode: 0o700, recursive: true });
  try {
    if (await registeredPath(registry, id) === pdfPath) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = file + "." + randomUUID();
  try {
    await fsp.writeFile(temp, pdfPath, { mode: 0o600 });
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

function watchDocument(pdfPath) {
  const clients = new Set();
  const pdfName = path.basename(pdfPath);
  const base = pdfName.slice(0, -4);
  let timer;
  const watcher = fs.watch(path.dirname(pdfPath), (_, name) => {
    if (name && ![pdfName, base + ".synctex", base + ".synctex.gz"].includes(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const tab of clients) tab.send("pdf-changed");
    }, 120);
  });
  watcher.on("error", error => console.error(`File watch error: ${error.message}`));
  return {
    clients, latestJump: 0,
    close() { watcher.close(); clearTimeout(timer); },
    target() { return [...clients].reduce((a, b) => a && a.lastFocus > b.lastFocus ? a : b, null); },
  };
}

export async function startServer({ host, port }) {
  const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  const origin = new URL("http://" + authority).origin;
  const registry = path.join(stateDirectory, documentId(origin));
  const active = new Map();
  function allowed(request) {
    const peer = request.headers.host;
    if ((host === "127.0.0.1" || host === "localhost" || host === "::1") && peer !== new URL(origin).host) return false;
    return !request.headers.origin || request.headers.origin === "http://" + peer;
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (!allowed(request)) return sendError(response, 403, "Forbidden");
      const url = new URL(request.url, origin);
      if (url.pathname === "/build/pdf.mjs" || url.pathname === "/build/pdf.renderer.mjs" || url.pathname === "/build/pdf.sandbox.mjs" || url.pathname === "/build/pdf.worker.mjs") {
        await serveFile(request, response, path.join(vendorDir, "build", path.basename(url.pathname)), "text/javascript; charset=utf-8");
        return;
      }
      if (url.pathname.startsWith("/web/")) {
        const filePath = safeStaticPath(path.join(vendorDir, "web"), url.pathname.slice("/web".length));
        if (!filePath) {
          sendError(response, 404, "Not found");
          return;
        }
        await serveFile(request, response, filePath, MIME[path.extname(filePath)] ?? "application/octet-stream");
        return;
      }
      const match = /^\/d\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);
      if (!match) return sendError(response, 404, "Not found");
      const [, id, route] = match;
      const pdfPath = await registeredPath(registry, id);
      const pdfName = path.basename(pdfPath);
      if (route === "/api/state" && request.method === "GET") {
        const stats = await fsp.stat(pdfPath);
        const syncTexPath = await findSyncTexPath(pdfPath);
        sendJson(response, 200, { pdf: `/d/${id}/pdf`, name: pdfName, path: pdfPath, size: stats.size, mtimeMs: stats.mtimeMs, syncTex: Boolean(syncTexPath), syncTexPath });
        return;
      }
      if (route === "/api/config" && request.method === "GET") {
        sendJson(response, 200, await loadSettings(pdfPath));
        return;
      }
      if (route === "/api/config" && request.method === "POST") {
        const settings = normalizeSettings(await readJson(request));
        await writeSettings(pdfPath, settings);
        sendJson(response, 200, settings);
        return;
      }
      if (route === "/api/synctex/forward" && request.method === "POST") {
        const body = await readJson(request);
        if (typeof body.source !== "string" || !body.source) throw Object.assign(new Error("source is required"), { statusCode: 400 });
        const result = await forwardSearch({ pdfPath, source: body.source, line: requireNumber(body.line, "line", 1), column: requireNumber(body.column ?? 1, "column", 1), settings: await loadSettings(pdfPath) });
        sendJson(response, 200, result);
        return;
      }
      if (route === "/api/synctex/inverse" && request.method === "POST") {
        const body = await readJson(request);
        const settings = await loadSettings(pdfPath);
        const result = await inverseSearch({ pdfPath, page: requireNumber(body.page, "page", 1), x: requireNumber(body.x, "x"), y: requireNumber(body.y, "y"), settings });
        if (body.openEditor !== false) {
          try { await openEditor({ result, pdfPath, settings }); } catch (error) { result.editorError = error.message; }
        }
        sendJson(response, 200, result);
        return;
      }
      if (route === "/pdf") {
        response.setHeader("content-disposition", "inline; filename*=UTF-8''" + encodeURIComponent(pdfName).replace(/'/g, "%27"));
        await serveFile(request, response, pdfPath, "application/pdf");
        return;
      }
      sendError(response, 404, "Not found");
    } catch (error) {
      sendError(response, error.statusCode ?? 500, error);
    }
  });
  const events = new WebSocketServer({ noServer: true, maxPayload: 128, clientTracking: false });
  server.on("upgrade", async (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    socket.setKeepAlive(true, 60000);
    try {
      const url = new URL(request.url, origin);
      const match = /^\/d\/([a-f0-9]{64})\/events$/.exec(url.pathname);
      const tabId = url.searchParams.get("tab");
      if (!allowed(request) || !match || !/^\d+(?:-\d+){3}$/.test(tabId)) return socket.destroy();
      const id = match[1];
      const pdfPath = await registeredPath(registry, id);
      events.handleUpgrade(request, socket, head, ws => {
        let doc = active.get(id);
        if (!doc) {
          doc = watchDocument(pdfPath);
          active.set(id, doc);
        }
        const tab = {
          socket, id: tabId, agent: request.headers["user-agent"] ?? "", lastFocus: 0,
          send(type, data) { ws.send(JSON.stringify({ type, data })); },
        };
        doc.clients.add(tab);
        ws.on("error", () => ws.terminate());
        ws.on("message", data => {
          if (data.toString() === "focus") tab.lastFocus = performance.now();
        });
        ws.once("close", () => {
          doc.clients.delete(tab);
          if (!doc.clients.size) {
            doc.close();
            active.delete(id);
          }
        });
      });
    } catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  try {
    await listenForCommands(host, port, async (request, response) => {
      try {
        const body = await readJson(request);
        const pdfPath = await fsp.realpath(body.pdf);
        const id = documentId(pdfPath);
        const url = origin + viewerPath(id);
        const doc = active.get(id);
        const tab = doc?.target();
        if (request.url === "/open") {
          if (!pdfPath.toLowerCase().endsWith(".pdf") || !(await fsp.stat(pdfPath)).isFile()) {
            throw new Error("Expected a PDF file");
          }
          await register(registry, pdfPath, id);
          let warning;
          if (body.open) {
            if (tab && process.platform === "darwin" && /Firefox\/|Chrome\/|Version\/.*Safari\//.test(tab.agent)) warning = await focusTab(tab);
            else openBrowser(url);
          }
          return sendJson(response, 200, { url, warning });
        }
        if (request.url !== "/jump") return sendError(response, 404, "Unknown command");
        if (!tab) throw new Error(`No viewer open for ${pdfPath}. Run texvu with that PDF first.`);
        const sequence = ++doc.latestJump;
        const { source, line, column, focus } = body;
        const position = await forwardSearch({ pdfPath, source, line, column, settings: await loadSettings(pdfPath) });
        if (sequence !== doc.latestJump) return sendJson(response, 200, {});
        const target = doc.target();
        if (!target) throw new Error(`Viewer disconnected. Open ${url}`);
        const warning = focus ? await focusTab(target) : undefined;
        if (sequence === doc.latestJump) {
          if (!doc.clients.has(target)) throw new Error(`Viewer disconnected. Open ${url}`);
          target.send("forward-search", position);
        }
        sendJson(response, 200, { warning });
      } catch (error) { sendError(response, 400, error); }
    });
  } catch (error) {
    server.close();
    throw error;
  }
  console.log(`texvu listening on ${origin}`);
}
