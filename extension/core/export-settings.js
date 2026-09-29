// Where exports are saved (spec journey-context-export FR-C3). One choice for
// every Journey, kept in extension storage so it survives browser restarts.

export const EXPORT_SETTINGS_KEY = "clicksheet-export-settings";
export const EXPORT_DESTINATIONS = Object.freeze(["downloads", "library"]);
export const DEFAULT_EXPORT_SETTINGS = Object.freeze({ destination: "downloads" });

export function normalizeExportSettings(value) {
  return {
    destination: EXPORT_DESTINATIONS.includes(value?.destination) ? value.destination : DEFAULT_EXPORT_SETTINGS.destination
  };
}

// `area` is a chrome.storage area, or anything with the same get/set shape.
export function createExportSettings(area) {
  return {
    async load() {
      const stored = await area.get(EXPORT_SETTINGS_KEY).catch(() => ({}));
      return normalizeExportSettings(stored?.[EXPORT_SETTINGS_KEY]);
    },
    async save(change) {
      if (!EXPORT_DESTINATIONS.includes(change?.destination)) throw new Error("Choose Downloads or the Clicksheet folder.");
      const next = normalizeExportSettings(change);
      await area.set({ [EXPORT_SETTINGS_KEY]: next });
      return next;
    }
  };
}

export function memoryStorageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    get: async (key) => (key in values ? { [key]: structuredClone(values[key]) } : {}),
    set: async (entries) => { Object.assign(values, structuredClone(entries)); }
  };
}
