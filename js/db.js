// Local storage (IndexedDB). Everything lives on the device: projects, photos, results, backgrounds, settings.
const DB_NAME = 'bg-studio';
const VERSION = 1;
const STORES = ['projects', 'photos', 'results', 'backgrounds', 'kv'];
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        const os = db.createObjectStore(s, { keyPath: 'id' });
        if (s === 'photos' || s === 'results') os.createIndex('projectId', 'projectId');
        if (s === 'results') os.createIndex('photoId', 'photoId');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function put(name, obj) { return req((await store(name, 'readwrite')).put(obj)); }
export async function get(name, id) { if (id == null) return undefined; return req((await store(name)).get(id)); }
export async function del(name, id) { return req((await store(name, 'readwrite')).delete(id)); }
export async function all(name) { return req((await store(name)).getAll()); }
export async function byIndex(name, index, value) { return req((await store(name)).index(index).getAll(value)); }
export async function clear(name) { return req((await store(name, 'readwrite')).clear()); }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function getSettings() {
  const s = (await get('kv', 'settings')) || {};
  return {
    id: 'settings',
    apiKey: '',
    imageModel: 'gemini-3.1-flash-image-preview',
    textModel: 'gemini-flash-latest',
    concurrency: 2,
    maxSide: 2048,
    ...s,
  };
}
export async function saveSettings(s) { return put('kv', { ...s, id: 'settings' }); }

export async function deleteProject(id) {
  for (const r of await byIndex('results', 'projectId', id)) await del('results', r.id);
  for (const p of await byIndex('photos', 'projectId', id)) await del('photos', p.id);
  await del('projects', id);
}

export async function deletePhoto(id) {
  for (const r of await byIndex('results', 'photoId', id)) await del('results', r.id);
  await del('photos', id);
}

export const STORE_NAMES = STORES;
