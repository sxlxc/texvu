import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { listenForJumps } from "./jump.js";
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
  await fsp.writeFile(path.join(path.dirname(pdfPath), CONFIG_FILE), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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

async function focusTab({ id, agent }) {
  if (process.platform !== "darwin" || !/^\d+(?:-\d+){3}$/.test(id)) return;
  let browser;
  if (/Chrome\//.test(agent)) browser = "com.google.Chrome";
  else if (/Version\/.*Safari\//.test(agent)) browser = "com.apple.Safari";
  if (!browser) return;
  try {
    const { stdout } = await runFile("/usr/bin/osascript", ["-l", "JavaScript", focusScript, browser, id], { timeout: 4000, killSignal: "SIGKILL" });
    if (stdout.trim() === "focused") return;
    return "Scrolled in the background. The browser could not locate the viewer tab.";
  } catch (error) {
    return `Scrolled in the background. Browser activation failed: ${error.stderr?.trim() || error.message}`;
  }
}

function safeStaticPath(root, requestPath) {
  const filePath = path.resolve(root, `.${requestPath}`);
  return filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
}

async function serveFile(request, response, filePath, contentType) {
  const stats = await fsp.stat(filePath);
  const range = request.headers.range;
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-cache");
  if (!range) {
    response.writeHead(200, { "content-length": stats.size });
    if (request.method !== "HEAD") fs.createReadStream(filePath).pipe(response);
    else response.end();
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) throw Object.assign(new Error("Invalid range"), { statusCode: 416 });
  const start = match[1] ? Number(match[1]) : Math.max(0, stats.size - Number(match[2]));
  const end = match[2] ? Number(match[2]) : stats.size - 1;
  if (start > end || start >= stats.size) throw Object.assign(new Error("Range not satisfiable"), { statusCode: 416 });
  response.writeHead(206, { "content-range": `bytes ${start}-${Math.min(end, stats.size - 1)}/${stats.size}`, "content-length": Math.min(end, stats.size - 1) - start + 1 });
  if (request.method !== "HEAD") fs.createReadStream(filePath, { start, end }).pipe(response);
  else response.end();
}

export async function startServer({ pdfPath, host = "127.0.0.1", port = 4173, open = false }) {
  const pdfStats = await fsp.stat(pdfPath).catch(() => null);
  if (!pdfStats?.isFile()) throw new Error(`PDF file does not exist: ${pdfPath}`);
  if (!pdfPath.toLowerCase().endsWith(".pdf")) throw new Error("The input file must have a .pdf extension");
  let settings = await loadSettings(pdfPath);
  const clients = new Map();
  function targetTab() {
    return [...clients.values()].sort((a, b) => b.lastFocus - a.lastFocus)[0];
  }
  let changeTimer;
  const notifyChange = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      for (const { response } of clients.values()) response.write(`event: pdf-changed\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    }, 120);
  };
  const directory = path.dirname(pdfPath);
  const pdfName = path.basename(pdfPath);
  const syncBase = path.basename(pdfPath, ".pdf");
  const watcher = fs.watch(directory, (event, filename) => {
    if (!filename) return;
    const name = filename.toString();
    if (name === pdfName || name === `${syncBase}.synctex` || name === `${syncBase}.synctex.gz`) notifyChange();
  });
  watcher.on("error", error => console.error(`File watch error: ${error.message}`));

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(302, { location: `/web/viewer.html?file=${encodeURIComponent("/pdf")}` });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        response.write(": connected\n\n");
        const id = url.searchParams.get("tab");
        clients.set(id, { response, id, agent: request.headers["user-agent"] ?? "", lastFocus: 0 });
        response.on("close", () => {
          if (clients.get(id)?.response === response) clients.delete(id);
        });
        return;
      }
      if (url.pathname === "/api/focus" && request.method === "POST") {
        const tab = clients.get(url.searchParams.get("tab"));
        if (tab) tab.lastFocus = Date.now();
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/api/state" && request.method === "GET") {
        const stats = await fsp.stat(pdfPath);
        const syncTexPath = await findSyncTexPath(pdfPath);
        sendJson(response, 200, { pdf: "/pdf", name: pdfName, path: pdfPath, size: stats.size, mtimeMs: stats.mtimeMs, syncTex: Boolean(syncTexPath), syncTexPath });
        return;
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        sendJson(response, 200, settings);
        return;
      }
      if (url.pathname === "/api/config" && request.method === "POST") {
        settings = normalizeSettings(await readJson(request));
        await writeSettings(pdfPath, settings);
        sendJson(response, 200, settings);
        return;
      }
      if (url.pathname === "/api/synctex/forward" && request.method === "POST") {
        const body = await readJson(request);
        if (typeof body.source !== "string" || !body.source) throw Object.assign(new Error("source is required"), { statusCode: 400 });
        const result = await forwardSearch({ pdfPath, source: body.source, line: requireNumber(body.line, "line", 1), column: requireNumber(body.column ?? 1, "column", 1), settings });
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/api/synctex/inverse" && request.method === "POST") {
        const body = await readJson(request);
        const result = await inverseSearch({ pdfPath, page: requireNumber(body.page, "page", 1), x: requireNumber(body.x, "x"), y: requireNumber(body.y, "y"), settings });
        if (body.openEditor !== false) {
          try { await openEditor({ result, pdfPath, settings }); } catch (error) { result.editorError = error.message; }
        }
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/pdf") {
        await serveFile(request, response, pdfPath, "application/pdf");
        return;
      }
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
      sendError(response, 404, "Not found");
    } catch (error) {
      sendError(response, error.statusCode ?? 500, error);
    }
  });
  server.on("close", () => watcher.close());
  await new Promise((resolve, reject) => {
    const onError = error => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const url = `http://${host}:${server.address().port}/web/viewer.html?file=${encodeURIComponent("/pdf")}`;
  let latestJump = 0;
  try {
    const control = await listenForJumps(pdfPath, async (request, response) => {
      try {
        if (request.method === "GET") return sendJson(response, 200, { lastFocus: targetTab()?.lastFocus ?? null });
        const noViewer = `No viewer open for ${pdfName}. Open ${url}`;
        if (!targetTab()) throw new Error(noViewer);
        const { source, line, column, focus = true } = await readJson(request);
        const sequence = ++latestJump;
        const position = await forwardSearch({ pdfPath, source, line, column, settings });
        if (sequence !== latestJump) return sendJson(response, 200, {});
        const tab = targetTab();
        if (!tab) throw new Error(noViewer);
        const warning = focus ? await focusTab(tab) : undefined;
        if (sequence !== latestJump) return sendJson(response, 200, {});
        if (tab.response.destroyed) throw new Error(noViewer);
        tab.response.write(`event: forward-search\ndata: ${JSON.stringify(position)}\n\n`);
        sendJson(response, 200, { warning });
      } catch (error) { sendError(response, 400, error); }
    });
    server.once("close", () => control.close());
  } catch (error) {
    server.close();
    throw error;
  }
  console.log(`texvu serving ${pdfPath}`);
  console.log(`Viewer: ${url}`);
  console.log(`SyncTeX: ${await findSyncTexPath(pdfPath) ? "available" : "not found"}`);
  if (open) openBrowser(url);
  return { server, url };
}
