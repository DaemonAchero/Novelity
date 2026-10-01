/* ===========================================================================
   db.js — IndexedDB storage layer for the reader
   ---------------------------------------------------------------------------
   The chapter list lives in IndexedDB, so the list, the read marks and the
   reading position survive a reload without localStorage's ~5 MB ceiling.

   A record is one chapter index row, as built by tools/build-data.mjs:

     { id, num, seq, heading, headingZh, titleZh, partZh, titleEn, partEn,
       curated, translated, paragraphs, words }

   Everything on that row but the chapter's identity comes from the English
   chapter in Doer/Result: `translated` says the run has written the file, and
   `paragraphs` / `words` are what that file holds. No chapter text is stored
   here, and nothing derived from the raw scan is written down — the reader
   fetches the two files a chapter owns (sources/chapter_NNNN/original.zh.txt
   for the Chinese, Doer/Result/chapter_NNNN/ for the English), so what is on
   screen is always what is in the files and a fresh translation shows up without
   re-seeding anything. This is what replaced the ~6 MB "pages" store of the
   earlier page-based build (version 1).

   Stores
     chapters : one record per chapter, shape above
     meta     : small key/value docs    { key:'seed' | 'progress', … }

   Seeding writes every row in a single transaction, straight after the list has
   been painted from the seed file.
   =========================================================================== */
const NovelDB = (() => {
  const NAME = 'novelity';
  const VERSION = 2;            // 2: chapters + meta only; the page store is gone
  const CHAPTERS = 'chapters';
  const META = 'meta';
  const OLD_PAGES = 'pages';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // the page records of the old page-based build are dead weight now
        if (db.objectStoreNames.contains(OLD_PAGES)) db.deleteObjectStore(OLD_PAGES);
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

  /**
   * Mirror the built chapter list into IndexedDB.
   * A reseed only happens when the seed file's version stamp changes — i.e. after
   * tools/build-data.mjs has produced a new list (a new translation, a new title)
   * — so opening the reader twice does not rewrite anything.
   */
  /**
   * Write the whole list and its version stamp in one transaction: two stores of
   * the same database share the commit, and (as seed() explains) the commit is
   * the only part of this that costs anything.
   */
  function writeSeed(data) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction([CHAPTERS, META], 'readwrite');
      const chapters = tx.objectStore(CHAPTERS);
      chapters.clear();
      data.chapters.forEach((c) => chapters.put(c));
      tx.objectStore(META).put({ key: 'seed', version: data.version, count: data.chapters.length, seededAt: Date.now() });
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  async function seed(data, onProgress) {
    const stored = await get(META, 'seed');
    if (stored && stored.version === data.version && stored.count === data.chapters.length) {
      return { seeded: false, chapters: data.chapters.length, version: stored.version };
    }
    // One transaction, one commit. The list is on screen from the seed long before
    // this runs, and 884 small rows cost nothing to put — what costs is the commit,
    // so writing them in six chunks (version 1) was six commits of waiting for no
    // benefit at all.
    await writeSeed(data);
    if (onProgress) onProgress(1);
    return { seeded: true, chapters: data.chapters.length, version: data.version };
  }

  const getChapter = (id) => get(CHAPTERS, id);
  const getChapters = () => getAll(CHAPTERS);
  const getProgress = () => get(META, 'progress');
  const setProgress = (chapterId, seq, heading) =>
    run(META, 'readwrite', (os) => {
      os.put({ key: 'progress', chapterId, seq, heading, updatedAt: Date.now() });
      return null;
    });
  const getMeta = (key) => get(META, key);

  async function stats() {
    return { chapters: await count(CHAPTERS), seed: await getMeta('seed') };
  }

  return {
    open, seed, stats,
    getChapter, getChapters,
    getProgress, setProgress, getMeta,
    isAvailable: () => typeof indexedDB !== 'undefined',
  };
})();
