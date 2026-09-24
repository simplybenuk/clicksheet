// Persists the selected root directory handle in extension-origin IndexedDB so
// access can be revalidated on later use.

const DATABASE_NAME = "clicksheet";
const STORE_NAME = "handles";
const ROOT_KEY = "root";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const database = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function loadRootHandle() {
  return withStore("readonly", (store) => store.get(ROOT_KEY));
}

export function saveRootHandle(handle) {
  return withStore("readwrite", (store) => store.put(handle, ROOT_KEY));
}
