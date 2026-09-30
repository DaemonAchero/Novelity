/* ===========================================================================
   db.js — IndexedDB storage layer for the reader
   ---------------------------------------------------------------------------
   The book is ~6 MB of page text (1,836 pages). localStorage only has a ~5 MB
   total quota and is synchronous, so every record lives in IndexedDB instead.

   Stores
     pages    : one record per page   { id, seq, chapterId, heading, translated,
                                        blocks:[{t:'p'|'d', x}], src:[...] }
     chapters : one record per chapter (drives the library list)
     meta     : small key/value docs  { key:'seed' | 'progress', ... }

   Records are written in chunks of CHUNK while seeding so the first paint is
   not blocked by a single 6 MB transaction.
   =========================================================================== */
const NovelDB = (() => {
  const NAME = 'novelity';
  const VERSION = 1;
  const PAGES = 'pages';
  const CHAPTERS = 'chapters';
  const META = 'meta';
  const CHUNK = 120;

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PAGES)) db.createObjectStore(PAGES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(CHAPTERS)) db.createObjectStore(CHAPTERS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function run(store, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let request;
      try { request = work(os); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  const get = (store, key) => run(store, 'readonly', (os) => os.get(key));
  const getAll = (store) => run(store, 'readonly', (os) => os.getAll());
  const count = (store) => run(store, 'readonly', (os) => os.count());
  const clear = (store) => run(store, 'readwrite', (os) => { os.clear(); return null; });

  /**
   * Mirror the built book into IndexedDB.
   * A reseed only happens when the seed file's version stamp changes
   * (i.e. after tools/build-data.mjs has produced new translations).
   */
  async function seed(data, onProgress) {
    const stored = await get(META, 'seed');
    if (stored && stored.version === data.version && stored.count === data.pages.length) {
      return { seeded: false, pages: data.pages.length, version: stored.version };
    }
    await clear(PAGES);
    await clear(CHAPTERS);
    const total = data.pages.length;
    for (let i = 0; i < total; i += CHUNK) {
      const slice = data.pages.slice(i, i + CHUNK);
      await run(PAGES, 'readwrite', (os) => { slice.forEach((p) => os.put(p)); return null; });
      if (onProgress) onProgress(Math.min(1, (i + slice.length) / total));
    }
    await run(CHAPTERS, 'readwrite', (os) => { data.chapters.forEach((c) => os.put(c)); return null; });
    await run(META, 'readwrite', (os) => {
      os.put({ key: 'seed', version: data.version, count: total, seededAt: Date.now() });
      return null;
    });
    return { seeded: true, pages: total, version: data.version };
  }

  const getPage = (id) => get(PAGES, id);
  const getChapter = (id) => get(CHAPTERS, id);
  const getChapters = () => getAll(CHAPTERS);
  const getProgress = () => get(META, 'progress');
  const setProgress = (pageId, seq, heading) =>
    run(META, 'readwrite', (os) => {
      os.put({ key: 'progress', pageId, seq, heading, updatedAt: Date.now() });
      return null;
    });
  const getMeta = (key) => get(META, key);

  async function stats() {
    return { pages: await count(PAGES), chapters: await count(CHAPTERS), seed: await getMeta('seed') };
  }

  return {
    open, seed, stats,
    getPage, getChapter, getChapters,
    getProgress, setProgress, getMeta,
    isAvailable: () => typeof indexedDB !== 'undefined',
  };
})();
