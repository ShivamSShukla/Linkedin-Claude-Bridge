// ============================================================
// QueueDB — Survives service worker death, Chrome restarts,
// 50-tab throttling. IndexedDB is the only truth.
// ============================================================

export class QueueDB {
  constructor() {
    this.dbName = 'GhostEngineDB';
    this.version = 2;
    this._db = null;
  }

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('queue')) {
          const store = db.createObjectStore('queue', { keyPath: 'id' });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('circuit')) {
          db.createObjectStore('circuit', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('context')) {
          db.createObjectStore('context', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('stats')) {
          db.createObjectStore('stats', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
  }

  async tx(storeName, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      if (req && req.onsuccess !== undefined) {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } else {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }
    });
  }

  // --- Queue Operations ---
  async enqueue(post) {
    const item = {
      id: `post_${post.urn || Date.now()}_${Math.random().toString(36).slice(2)}`,
      postData: post,
      status: 'PENDING',
      draftedReply: null,
      classification: null,
      identityScore: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await this.tx('queue', 'readwrite', s => s.put(item));
    return item.id;
  }

  async getByStatus(status) {
    return this.tx('queue', 'readonly', store => {
      return store.index('status').getAll(status);
    });
  }

  async getAll() {
    return this.tx('queue', 'readonly', store => store.getAll());
  }

  async updateStatus(id, status, patch = {}) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      const store = tx.objectStore('queue');
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const item = getReq.result;
        if (!item) return reject(new Error(`Item ${id} not found`));
        store.put({ ...item, ...patch, status, updatedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  async remove(id) {
    await this.tx('queue', 'readwrite', s => s.delete(id));
  }

  // --- Circuit State ---
  async setCircuit(state) {
    await this.tx('circuit', 'readwrite', s => s.put({ key: 'main', ...state }));
  }

  async getCircuit() {
    return this.tx('circuit', 'readonly', s => s.get('main'));
  }

  // --- Context Cache ---
  async setContext(data) {
    await this.tx('context', 'readwrite', s => s.put({ key: 'live', ...data, cachedAt: Date.now() }));
  }

  async getContext() {
    return this.tx('context', 'readonly', s => s.get('live'));
  }

  // --- Stats ---
  async incrementStat(key, by = 1) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('stats', 'readwrite');
      const store = tx.objectStore('stats');
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const current = getReq.result || { key, value: 0 };
        store.put({ ...current, value: current.value + by });
        tx.oncomplete = resolve;
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async getStat(key) {
    const r = await this.tx('stats', 'readonly', s => s.get(key));
    return r ? r.value : 0;
  }
}

export const db = new QueueDB();
