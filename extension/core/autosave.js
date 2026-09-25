// Debounced autosave with the user-visible save states from FR-004.
//
// A failed save moves to `Storage unavailable` and keeps the unsaved change.
// No further writes are attempted until `retry()` runs after the folder is
// reconnected, so nothing is written elsewhere and nothing is reported as saved.
// `suspend()` holds edits in memory without writing, for example while the
// library is being copied to another folder.

export const SAVE_STATUS = Object.freeze({
  idle: "idle",
  saving: "Saving",
  saved: "Saved locally",
  unavailable: "Storage unavailable"
});

export function createAutosave({
  save,
  onStatus = () => {},
  delayMs = 400,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let status = SAVE_STATUS.idle;
  let pending;
  let hasPending = false;
  let timer = null;
  let inFlight = null;
  let lastError = null;
  // Suspensions nest: writes resume when every suspend() has been resumed.
  let suspensions = 0;

  function setStatus(next) {
    if (status !== next) {
      status = next;
      onStatus(next, lastError);
    }
  }

  function cancelTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  async function drain() {
    while (hasPending && suspensions === 0 && status !== SAVE_STATUS.unavailable) {
      const value = pending;
      hasPending = false;
      pending = undefined;

      try {
        await save(value);
      } catch (error) {
        // Keep the newest unsaved value; an older one is superseded by it.
        if (!hasPending) {
          pending = value;
          hasPending = true;
        }

        lastError = error;
        setStatus(SAVE_STATUS.unavailable);
        return false;
      }
    }

    if (status === SAVE_STATUS.unavailable) {
      return false;
    }

    if (hasPending) {
      return true;
    }

    lastError = null;
    setStatus(SAVE_STATUS.saved);
    return true;
  }

  function run() {
    if (!inFlight) {
      inFlight = drain().finally(() => {
        inFlight = null;
      });
    }

    return inFlight;
  }

  async function flush() {
    cancelTimer();

    while (inFlight || (hasPending && suspensions === 0 && status !== SAVE_STATUS.unavailable)) {
      await run();
    }

    return status !== SAVE_STATUS.unavailable;
  }

  return {
    get status() {
      return status;
    },

    get hasPendingChanges() {
      return hasPending;
    },

    get lastError() {
      return lastError;
    },

    schedule(value) {
      pending = value;
      hasPending = true;

      if (status === SAVE_STATUS.unavailable) {
        return;
      }

      setStatus(SAVE_STATUS.saving);

      if (suspensions > 0) {
        return;
      }

      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        void run();
      }, delayMs);
    },

    flush,

    get suspended() {
      return suspensions > 0;
    },

    // Waits for any write in progress, then holds new edits until resume().
    async suspend() {
      suspensions += 1;
      cancelTimer();

      while (inFlight) {
        await inFlight;
      }
    },

    resume() {
      suspensions = Math.max(0, suspensions - 1);
      return flush();
    },

    // Call after storage access has been restored.
    async retry() {
      if (status === SAVE_STATUS.unavailable) {
        setStatus(hasPending ? SAVE_STATUS.saving : SAVE_STATUS.saved);
      }

      return flush();
    }
  };
}
