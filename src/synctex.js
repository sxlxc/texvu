import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const defaultEditor = process.platform === "darwin"
  ? { editorCommand: "open", editorArgs: ["-g", "vscode://file{file}:{line}:{column}"] }
  : { editorCommand: "code", editorArgs: ["--reuse-window", "--goto", "{file}:{line}:{column}"] };

export const DEFAULT_SETTINGS = {
  synctexCommand: "synctex",
  synctexForwardArgs: ["view", "-i", "{line}:{column}:{source}", "-o", "{pdf}"],
  synctexInverseArgs: ["edit", "-o", "{page}:{x}:{y}:{pdf}"],
  ...defaultEditor,
};

function substitute(value, variables) {
  return String(value).replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? "");
}

function run(command, args, cwd, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function parseSyncTexOutput(output) {
  const records = [];
  let record = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "Input" && record.file) {
      records.push(record);
      record = {};
    }
    if (["Page", "x", "y", "h", "v", "W", "H", "Line", "Column"].includes(key)) {
      record[key] = Number(value);
    } else if (key === "Input" || key === "File") {
      record[key === "Input" ? "file" : "pdf"] = value;
    }
  }
  if (record.file || record.pdf || record.Page) records.push(record);
  return records;
}

export async function findSyncTexPath(pdfPath) {
  const base = pdfPath.endsWith(".pdf") ? pdfPath.slice(0, -4) : pdfPath;
  for (const candidate of [`${base}.synctex.gz`, `${base}.synctex`]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep looking for the other supported format.
    }
  }
  return null;
}

export async function forwardSearch({ pdfPath, source, line, column, settings }) {
  const variables = { pdf: pdfPath, source: path.resolve(source), line, column };
  const args = settings.synctexForwardArgs.map(arg => substitute(arg, variables));
  const output = await run(settings.synctexCommand, args, path.dirname(pdfPath));
  const record = parseSyncTexOutput(output).find(item => item.Page && (item.x ?? item.h) !== undefined);
  if (!record) throw new Error("SyncTeX returned no matching PDF position");
  return { page: record.Page, x: record.x ?? record.h, y: record.y ?? record.v };
}

export async function inverseSearch({ pdfPath, page, x, y, settings }) {
  const variables = { pdf: pdfPath, page, x, y };
  const args = settings.synctexInverseArgs.map(arg => substitute(arg, variables));
  const output = await run(settings.synctexCommand, args, path.dirname(pdfPath));
  const record = parseSyncTexOutput(output).find(item => item.file && item.Line);
  if (!record) throw new Error("SyncTeX returned no matching source position");
  const file = path.isAbsolute(record.file) ? record.file : path.resolve(path.dirname(pdfPath), record.file);
  return { file: path.normalize(file), line: record.Line, column: record.Column > 0 ? record.Column : 1 };
}

export async function openEditor({ result, pdfPath, settings }) {
  const variables = { ...result, pdf: pdfPath };
  const args = settings.editorArgs.map(arg => substitute(arg, variables));
  await run(settings.editorCommand, args, path.dirname(pdfPath), 10000);
}
