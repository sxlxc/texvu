(() => {
  "use strict";

  const progressKey = "pdfjs-synctex:progress";
  let application;
  let documentState;
  let saveTimer;
  let statusTimer;
  let restoring = false;

  function readProgress() {
    try { return JSON.parse(localStorage.getItem(progressKey) || "{}"); } catch { return {}; }
  }
  function saveProgress() {
    if (!application?.pdfDocument || !documentState) return;
    const location = application.pdfViewer._location;
    const progress = readProgress();
    progress[documentState.path] = {
      page: application.pdfViewer.currentPageNumber,
      scale: application.pdfViewer.currentScaleValue,
      left: location?.left ?? 0,
      top: location?.top ?? 0,
      pdfOpenParams: location?.pdfOpenParams ?? null,
    };
    localStorage.setItem(progressKey, JSON.stringify(progress));
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 150);
  }
  function showStatus(message) {
    let element = document.querySelector("#synctexStatus");
    if (!element) {
      element = document.createElement("div");
      element.id = "synctexStatus";
      element.className = "messageBar";
      element.setAttribute("role", "status");
      document.body.append(element);
    }
    element.textContent = message;
    element.classList.add("visible");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => element.classList.remove("visible"), 3000);
  }
  async function getDocumentState() {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read PDF state");
    return response.json();
  }
  function restoreProgress() {
    if (restoring || !application?.pdfDocument || !documentState) return;
    restoring = true;
    const saved = readProgress()[documentState.path];
    if (saved?.pdfOpenParams) {
      application.pdfLinkService.setHash(saved.pdfOpenParams.replace(/^#/, ""));
    } else if (saved?.scale || saved?.page) {
      if (saved?.scale) application.pdfViewer.currentScaleValue = saved.scale;
      application.pdfViewer.scrollPageIntoView({
        pageNumber: saved.page || 1,
        destArray: [null, { name: "XYZ" }, saved.left ?? 0, saved.top ?? null, null],
        ignoreDestinationZoom: true,
      });
    }
    if (!saved?.pdfOpenParams) application.pdfViewer.currentPageNumber = saved?.page || 1;
    restoring = false;
  }
  async function reloadDocument() {
    saveProgress();
    try {
      const nextState = await getDocumentState();
      documentState = nextState;
      document.title = nextState.name ? `${nextState.name} - PDF.js` : "PDF.js viewer";
      await application.open({ url: `/pdf?mtime=${encodeURIComponent(nextState.mtimeMs)}` });
      showStatus("PDF reloaded");
    } catch (error) { showStatus(error.message); }
  }
  async function forwardSyncTeX() {
    const source = window.prompt("Source file path", documentState.path.replace(/\.pdf$/i, ".tex"));
    if (!source) return;
    const line = Number(window.prompt("Source line", "1"));
    if (!Number.isFinite(line) || line < 1) return;
    try {
      const response = await fetch("/api/synctex/forward", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, line, column: 1 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const page = await application.pdfDocument.getPage(result.page);
      const pageHeight = page.getViewport({ scale: 1 }).height;
      application.pdfViewer.scrollPageIntoView({
        pageNumber: result.page,
        destArray: [null, { name: "XYZ" }, result.x, pageHeight - result.y, null],
        ignoreDestinationZoom: true,
      });
      showStatus(`SyncTeX: ${source}:${line}`);
    } catch (error) { showStatus(error.message); }
  }
  async function inverseSyncTeX(event) {
    if (!(event.ctrlKey || event.metaKey) || !application?.pdfDocument) return;
    const pageElement = event.target.closest(".page[data-page-number]");
    if (!pageElement) return;
    event.preventDefault();
    const pageNumber = Number(pageElement.dataset.pageNumber);
    const pageView = application.pdfViewer.getPageView(pageNumber - 1);
    const rect = pageElement.getBoundingClientRect();
    const [x, y] = pageView.getPagePoint(event.clientX - rect.left, pageView.viewport.height - (event.clientY - rect.top));
    try {
      const response = await fetch("/api/synctex/inverse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: pageNumber, x, y, openEditor: false }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const vscodeUri = encodeURI(`vscode://file${result.file}:${result.line}:${result.column}`);
      window.location.href = vscodeUri;
      showStatus(`SyncTeX: ${result.file}:${result.line}:${result.column}`);
    } catch (error) { showStatus(error.message); }
  }
  function addToolbarButton(id, label, callback) {
    const container = document.querySelector("#secondaryToolbarButtonContainer");
    if (!container || document.querySelector(`#${id}`)) return;
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "toolbarButton labeled";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.textContent = label;
    button.addEventListener("click", callback);
    container.append(button);
  }
  function settingsDialog() {
    let dialog = document.querySelector("#synctexSettingsDialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "synctexSettingsDialog";
    dialog.innerHTML = `<form method="dialog" class="synctexDialogContent">
      <h2>SyncTeX commands</h2>
      <p>Arguments are one item per line. Use {pdf}, {source}, {line}, {column}, {page}, {x}, {y}, and {file}.</p>
      <label>SyncTeX executable <input name="synctexCommand" autocomplete="off"></label>
      <label>Forward arguments <textarea name="synctexForwardArgs" rows="4"></textarea></label>
      <label>Inverse arguments <textarea name="synctexInverseArgs" rows="3"></textarea></label>
      <label>Editor executable <input name="editorCommand" autocomplete="off"></label>
      <label>Editor arguments <textarea name="editorArgs" rows="3"></textarea></label>
      <div class="synctexDialogActions"><button value="cancel">Cancel</button><button value="save" class="primaryButton">Save</button></div>
    </form>`;
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "save") return;
      const form = dialog.querySelector("form");
      const lines = name => form.elements[name].value.split("\n").map(value => value.trim()).filter(Boolean);
      fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          synctexCommand: form.elements.synctexCommand.value.trim(),
          synctexForwardArgs: lines("synctexForwardArgs"),
          synctexInverseArgs: lines("synctexInverseArgs"),
          editorCommand: form.elements.editorCommand.value.trim(),
          editorArgs: lines("editorArgs"),
        }),
      }).then(response => response.ok ? showStatus("SyncTeX settings saved") : showStatus("Could not save SyncTeX settings"));
    });
    document.body.append(dialog);
    return dialog;
  }
  async function openSettings() {
    const dialog = settingsDialog();
    const form = dialog.querySelector("form");
    const settings = await fetch("/api/config", { cache: "no-store" }).then(response => response.json());
    form.elements.synctexCommand.value = settings.synctexCommand;
    form.elements.synctexForwardArgs.value = settings.synctexForwardArgs.join("\n");
    form.elements.synctexInverseArgs.value = settings.synctexInverseArgs.join("\n");
    form.elements.editorCommand.value = settings.editorCommand;
    form.elements.editorArgs.value = settings.editorArgs.join("\n");
    dialog.showModal();
  }
  document.addEventListener("webviewerloaded", async () => {
    application = window.PDFViewerApplication;
    await application.initializedPromise;
    documentState = await getDocumentState();
    document.title = documentState.name ? `${documentState.name} - PDF.js` : "PDF.js viewer";
    const eventBus = application.eventBus;
    eventBus.on("pagesloaded", restoreProgress);
    eventBus.on("pagechanging", scheduleSave);
    eventBus.on("scalechanging", scheduleSave);
    eventBus.on("updateviewarea", scheduleSave);
    document.querySelector("#viewerContainer").addEventListener("click", inverseSyncTeX, true);
    addToolbarButton("synctexForwardButton", "SyncTeX forward search", forwardSyncTeX);
    addToolbarButton("synctexSettingsButton", "SyncTeX settings", openSettings);
    const events = new EventSource("/events");
    events.addEventListener("pdf-changed", reloadDocument);
    window.addEventListener("beforeunload", saveProgress);
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        forwardSyncTeX();
      }
    });
  }, { once: true });
})();
