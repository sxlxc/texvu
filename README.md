# texvu

`texvu` is a small local server for reading a LaTeX PDF in the stock PDF.js viewer used by Firefox. It watches the PDF and its SyncTeX sidecar, reloads after an atomic rebuild, and preserves the viewer's page, scroll position, and zoom level.

## Quick start

```sh
brew install sxlxc/texvu/texvu
brew services start texvu
texvu main.pdf
```

Homebrew runs one daemon at `127.0.0.1:4173` and starts it again at login. `texvu main.pdf` opens the viewer and exits. Use `texvu --no-open main.pdf` to print its bookmarkable URL. The same PDF keeps its URL across terminal sessions, browser restarts, and daemon restarts. PDFs with the same filename in different directories have separate URLs. Use `brew services stop texvu` to stop serving them.

From a source checkout, run `npm ci` and `node src/cli.js daemon`, then `node src/cli.js main.pdf` in another terminal. For a different port, pass the same `--port` to the daemon, open, and jump commands. The same rule applies to `--host`. Bind to a public interface only on a trusted network because viewers can configure local editor and SyncTeX commands.

Build the document with SyncTeX enabled. For example, LaTeX Workshop recipes commonly pass `-synctex=1`.

```sh
pdflatex -synctex=1 main.tex
```

The viewer looks beside the PDF for `main.synctex.gz` and `main.synctex`. It invokes the local `synctex` executable for source-to-PDF and PDF-to-source lookups. The browser shortcut for forward search is `Ctrl+Alt+J` or `Cmd+Option+J`, matching LaTeX Workshop. Hold `Ctrl` or `Cmd` while clicking a page for inverse search.

## Forward search from VS Code

Start `texvu main.pdf` once. For Texlab, add these entries to VS Code settings:

```json
{
  "texlab.forwardSearch.executable": "/opt/homebrew/bin/texvu",
  "texlab.forwardSearch.args": ["jump", "%p", "%f", "%l"]
}
```

Use your installed executable path if it differs. Texlab’s forward-search command scrolls the most recently focused viewer for the output PDF. On macOS, texvu brings that tab to the front in Firefox, Safari, or Google Chrome. For Firefox, raising the selected viewer works directly. Selecting a hidden tab uses macOS Accessibility permission for the app running the texvu server. macOS may request Automation permission on the first jump. To keep keyboard focus in the editor, set `"texlab.forwardSearch.args": ["jump", "--no-focus", "%p", "%f", "%l"]`. Other browsers and platforms scroll in the background. If the server or viewer is closed, the command reports how to open it. From a terminal, use `texvu jump main.pdf chapters/intro.tex 42`.

## Settings

The Settings button edits `.pdfjs-synctex.json` beside the PDF. Commands use argument arrays and are executed without a shell. These placeholders are available:

| Placeholder | Value |
| --- | --- |
| `{pdf}` | Absolute PDF path |
| `{source}` | Absolute source path |
| `{line}`, `{column}` | Source position |
| `{page}`, `{x}`, `{y}` | PDF position |
| `{file}` | Source file returned by inverse SyncTeX |

Cmd/Ctrl-click opens VS Code through a `vscode://file/{path}:{line}:{column}` URI, allowing the existing VS Code application to handle the request. The server-side fallback uses `open -g` on macOS and `code --reuse-window --goto` elsewhere. These commands can be changed in Settings.

The shipped defaults correspond to the SyncTeX CLI forms `synctex view -i line:column:source -o pdf` and `synctex edit -o page:x:y:pdf`.

## Design notes

- The Firefox-style PDF.js viewer and its locale, icon, font, CMap, and WASM assets are vendored from the PDF.js 4.10.38 distribution release.
- The PDF.js runtime and worker are served locally, so the viewer works without a CDN and without disabling the worker.
- Each open tab has an event-driven WebSocket connection. A rebuild refreshes all tabs for that PDF. A forward search scrolls only its most recently focused tab.
- The daemon streams PDF byte ranges from disk and shares one filesystem watcher among the tabs for a PDF. Closing the last tab releases the watcher. Idle documents keep only a path record under `$XDG_STATE_HOME/texvu/documents` (default `~/.local/state/texvu/documents`).
- The CLI registers PDFs and sends jump requests over a local control socket.

The vendored PDF.js files are covered by the Apache 2.0 license in [vendor/pdfjs/LICENSE](vendor/pdfjs/LICENSE). The project code remains MIT licensed.

## Research references

- [PDF.js API and examples](https://mozilla.github.io/pdf.js/api/index.html)
- [PDF.js third-party viewer event bus](https://github.com/mozilla/pdf.js/wiki/Third-party-viewer-usage)
- [SyncTeX command-line reference](https://man.archlinux.org/man/synctex.1.en)
- [LaTeX Workshop SyncTeX settings](https://github.com/James-Yu/LaTeX-Workshop/wiki/View)
- [VS Code command-line interface](https://code.visualstudio.com/docs/configure/command-line)
