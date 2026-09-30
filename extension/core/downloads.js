// Saves an image and its context into Downloads/<folder> (spec
// journey-context-export FR-C3.2). The worker cannot make blob URLs, so the
// files go to Chrome as data URLs. `api` is chrome.downloads, or a stand-in in
// tests.
//
// The context file must share the image's base name. Chrome's uniquify names
// each file on its own, so if a stray <base>.json already exists the context
// would get "<base> (1).json" next to "<base>.png". When that happens both new
// files are removed and the pair is saved again under a base with a suffix.

export const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 5;

export function createDownloadsExporter({
  api,
  toDataUrl,
  folder = "Clicksheet",
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer)
}) {
  const place = `Downloads/${folder}`;

  async function save({ name, image, context }) {
    const imageUrl = await toDataUrl(image);
    const contextUrl = await toDataUrl(context);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const base = attempt === 1 ? name : `${name}-${attempt}`;
      const saved = await download(imageUrl, `${folder}/${base}.png`);
      const fileName = leafName(saved.filename);
      const pairBase = fileName.replace(/\.png$/i, "");
      let contextItem;
      try {
        contextItem = await download(contextUrl, `${folder}/${pairBase}.json`);
      } catch {
        throw new Error(`Saved ${fileName} in ${place}, but its context file could not be saved. Save again to get both files.`);
      }
      const contextFileName = leafName(contextItem.filename);
      if (contextFileName === `${pairBase}.json`) return { downloadId: saved.id, fileName, contextFileName };
      // Something other than uniquify named the files (another extension, or
      // browser automation, which uses random names). Another base would be
      // overridden the same way, so the names Chrome used are reported as is.
      if (!namedByUniquify(fileName, base, ".png")) return { downloadId: saved.id, fileName, contextFileName };
      const removed = await Promise.all([discard(contextItem.id), discard(saved.id)]);
      if (!removed.every(Boolean)) {
        throw new Error(`Saved ${fileName} and its context as ${contextFileName} in ${place}, but the names do not match because an older file is in the way. Rename or remove the older file and save again.`);
      }
    }
    throw new Error(`Clicksheet could not find a name free for both files in ${place}. Rename or remove older ${name} files and save again.`);
  }

  async function discard(id) {
    try {
      await api.removeFile(id);
    } catch {
      return false;
    }
    await api.erase({ id }).catch(() => {});
    return true;
  }

  // Resolves with the finished download item. Rejects if Chrome gives up or
  // the download does not finish in time; a late download is cancelled.
  function download(url, filename) {
    const label = leafName(filename);
    return new Promise((resolve, reject) => {
      let id = null;
      let settled = false;
      const early = [];
      const stop = () => {
        settled = true;
        clearTimer(timer);
        api.onChanged.removeListener(listener);
      };
      const finish = async (state) => {
        if (settled) return;
        stop();
        const [item] = await api.search({ id }).catch(() => []);
        if (state === "complete" && item) resolve(item);
        else reject(new Error(`Chrome could not save ${label}${item?.error ? ` (${item.error})` : ""}.`));
      };
      function listener(delta) {
        if (id === null) { early.push(delta); return; }
        if (delta.id === id && delta.state && delta.state.current !== "in_progress") void finish(delta.state.current);
      }
      const timer = setTimer(() => {
        if (settled) return;
        stop();
        if (id !== null) void Promise.resolve(api.cancel(id)).catch(() => {});
        const seconds = Math.max(1, Math.round(timeoutMs / 1000));
        reject(new Error(`Chrome did not finish saving ${label} within ${seconds} second${seconds === 1 ? "" : "s"}. Check Chrome's downloads, then save again.`));
      }, timeoutMs);
      api.onChanged.addListener(listener);
      api.download({ url, filename, conflictAction: "uniquify", saveAs: false }).then(async (downloadId) => {
        id = downloadId;
        // The timeout already fired: the caller has been told, so stop this one.
        if (settled) { void Promise.resolve(api.cancel(downloadId)).catch(() => {}); return; }
        for (const delta of early.splice(0)) listener(delta);
        const [item] = await api.search({ id }).catch(() => []);
        if (item && item.state !== "in_progress") void finish(item.state);
      }, (error) => {
        if (settled) return;
        stop();
        reject(new Error(`Chrome could not save ${label}. ${error?.message ?? ""}`.trim()));
      });
    });
  }

  return { save, download };
}

// True for "<base>.png" or Chrome's uniquify form "<base> (N).png".
function namedByUniquify(fileName, base, extension) {
  if (fileName === `${base}${extension}`) return true;
  const prefix = `${base} (`;
  const suffix = `)${extension}`;
  return fileName.startsWith(prefix) && fileName.endsWith(suffix) && /^\d+$/.test(fileName.slice(prefix.length, -suffix.length));
}

export function leafName(path) {
  return String(path ?? "").split(/[\\/]/).pop();
}
