#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import fs from "node:fs/promises";
import { jump } from "./jump.js";
import { startServer } from "./server.js";

const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

function printHelp() {
  console.log(`texvu ${packageJson.version}
Serve a local PDF.js viewer with SyncTeX support.

Usage:
  texvu [options] <file.pdf>
  texvu jump [--no-focus] <file.pdf> <source.tex> <line> [column]

Options:
  -p, --port <number>   Port to listen on (default: automatic)
  -H, --host <address>  Address to bind (default: 127.0.0.1)
      --open            Open the viewer in the default browser (default)
      --no-open         Print the URL without opening a browser
      --no-focus        Scroll without activating the browser (jump only)
  -h, --help            Show this help
  -v, --version         Show the version

Examples:
  texvu thesis.pdf
  texvu --port 8080 thesis.pdf
  texvu --host 0.0.0.0 thesis.pdf --no-open

The viewer looks for thesis.synctex.gz or thesis.synctex beside the PDF.
`);
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { host: "127.0.0.1", port: undefined, open: true };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") options.help = true;
    else if (value === "-v" || value === "--version") options.version = true;
    else if (value === "--open") options.open = true;
    else if (value === "--no-open") options.open = false;
    else if (value === "-p" || value === "--port") options.port = Number(optionValue(argv, index++, value));
    else if (value.startsWith("--port=")) options.port = Number(value.slice("--port=".length));
    else if (value === "-H" || value === "--host") options.host = optionValue(argv, index++, value);
    else if (value.startsWith("--host=")) options.host = value.slice("--host=".length);
    else if (value === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    else if (value.startsWith("-")) throw new Error(`Unknown option ${value}`);
    else positional.push(value);
  }
  if (positional.length > 1) throw new Error("only one PDF path may be provided");
  options.pdf = positional[0];
  if (!options.host) throw new Error("--host requires a value");
  if (options.port !== undefined && (options.port < 1 || options.port > 65535 || !Number.isInteger(options.port))) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

let options;
try {
  if (process.argv[2] === "jump") {
    const args = process.argv.slice(3);
    const focus = !args.includes("--no-focus");
    const [pdf, source, line, column = "1", ...extra] = args.filter(arg => arg !== "--no-focus");
    if (!pdf || !source || extra.length || ![line, column].every(n => /^[1-9]\d*$/.test(n) && Number.isSafeInteger(Number(n)))) {
      throw new Error("Usage: texvu jump [--no-focus] <file.pdf> <source.tex> <line> [column]");
    }
    await jump(pdf, source, Number(line), Number(column), focus);
    process.exit(0);
  }
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`texvu: ${error.message}`);
  process.exit(1);
}
if (options.version) {
  console.log(packageJson.version);
  process.exit(0);
}
if (options.help || !options.pdf) {
  printHelp();
  process.exit(options.help ? 0 : 1);
}

try {
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  await startServer({
    pdfPath: path.resolve(options.pdf),
    host: options.host,
    port: options.port ?? 0,
    open: options.open,
  });
} catch (error) {
  console.error(`texvu: ${error.message}`);
  process.exit(1);
}
