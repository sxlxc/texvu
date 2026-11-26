#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import fs from "node:fs/promises";
import { command, DEFAULT_HOST, DEFAULT_PORT } from "./jump.js";

const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

function printHelp() {
  console.log(`texvu ${packageJson.version}
Serve a local PDF.js viewer with SyncTeX support.

Usage:
  texvu daemon [--host <address>] [--port <number>]
  texvu [options] <file.pdf>
  texvu jump [options] [--no-focus] <file.pdf> <source.tex> <line> [column]

Options:
  -p, --port <number>   Daemon port (default: 4173)
  -H, --host <address>  Address to bind (default: 127.0.0.1)
      --open            Open the viewer in the default browser (default)
      --no-open         Print the URL without opening a browser
      --no-focus        Scroll without activating the browser (jump only)
  -h, --help            Show this help
  -v, --version         Show the version

Examples:
  texvu thesis.pdf
  texvu --no-open thesis.pdf

The viewer looks for thesis.synctex.gz or thesis.synctex beside the PDF.
`);
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT, open: true };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") options.help = true;
    else if (value === "-v" || value === "--version") options.version = true;
    else if (value === "--no-focus") options.focus = false;
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
  if (!options.host) throw new Error("--host requires a value");
  if (options.port !== undefined && (options.port < 1 || options.port > 65535 || !Number.isInteger(options.port))) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return { ...options, positional };
}

try {
  const args = process.argv.slice(2);
  const action = ["daemon", "jump"].includes(args[0]) ? args.shift() : "open";
  const { host, port, open, focus = true, positional, help, version } = parseArgs(args);
  const [pdf, source, line, column = "1", ...extra] = positional;
  if (version) console.log(packageJson.version);
  else if (help) printHelp();
  else if (action === "daemon") {
    if (positional.length) throw new Error("Usage: texvu daemon [--host <address>] [--port <number>]");
    const { startServer } = await import("./server.js");
    await startServer({ host, port });
  } else if (action === "jump") {
    if (!source || extra.length || ![line, column].every(n => /^[1-9]\d*$/.test(n) && Number.isSafeInteger(Number(n)))) {
      throw new Error("Usage: texvu jump [--no-focus] <file.pdf> <source.tex> <line> [column]");
    }
    const { warning } = await command(host, port, action, {
      pdf: path.resolve(pdf), source: path.resolve(source), line: Number(line), column: Number(column), focus,
    });
    if (warning) console.error(`texvu: ${warning}`);
  } else if (!pdf) {
    printHelp();
    process.exitCode = 1;
  } else {
    if (positional.length !== 1) throw new Error("only one PDF path may be provided");
    const result = await command(host, port, action, { pdf: path.resolve(pdf), open });
    console.log(result.url);
    if (result.warning) console.error(`texvu: ${result.warning}`);
  }
} catch (error) {
  console.error(`texvu: ${error.message}`);
  process.exitCode = 1;
}
