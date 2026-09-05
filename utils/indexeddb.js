const STARWAVE_DB_NAME = "STARWAVE_DB";
const STARWAVE_DB_VERSION = 1;

const STARWAVE_STATE_STORE = "appState";
const STARWAVE_STATE_KEY = "main";

let starwaveDbPromise = null;

function openStarwaveDB() {
  if (starwaveDbPromise) {
    return starwaveDbPromise;
  }

  starwaveDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(
      STARWAVE_DB_NAME,
      STARWAVE_DB_VERSION
    );

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STARWAVE_STATE_STORE)) {
        db.createObjectStore(STARWAVE_STATE_STORE);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });

  return starwaveDbPromise;
}

async function saveStarwaveState(state) {
  const db = await openStarwaveDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STARWAVE_STATE_STORE,
      "readwrite"
    );

    const store = transaction.objectStore(
      STARWAVE_STATE_STORE
    );

    const request = store.put(
      structuredClone(state),
      STARWAVE_STATE_KEY
    );

    request.onsuccess = () => resolve();

    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function loadStarwaveState() {
  const db = await openStarwaveDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STARWAVE_STATE_STORE,
      "readonly"
    );

    const store = transaction.objectStore(
      STARWAVE_STATE_STORE
    );

    const request = store.get(
      STARWAVE_STATE_KEY
    );

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function deleteStarwaveState() {
  const db = await openStarwaveDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STARWAVE_STATE_STORE,
      "readwrite"
    );

    const store = transaction.objectStore(
      STARWAVE_STATE_STORE
    );

    const request = store.delete(
      STARWAVE_STATE_KEY
    );

    request.onsuccess = () => resolve();

    request.onerror = () => {
      reject(request.error);
    };
  });
}
