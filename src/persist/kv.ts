/** Minimal async key-value storage abstraction with memory and IndexedDB backends. */

export interface KeyValueStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export class MemoryKeyValueStore<V> implements KeyValueStore<V> {
  private readonly map = new Map<string, V>();
  async get(key: string): Promise<V | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: V): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
}

const DB_VERSION = 1;
export const IDB_STORES = ["graphs", "parse-cache"] as const;
export type IdbStoreName = (typeof IDB_STORES)[number];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbs = new Map<string, Promise<IDBDatabase>>();

function openDb(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  let db = dbs.get(name);
  if (db === undefined) {
    db = new Promise((resolve, reject) => {
      const req = factory.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const store of IDB_STORES) {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbs.set(name, db);
    db.catch(() => dbs.delete(name));
  }
  return db;
}

/** IndexedDB-backed store (browser). Values are stored via structured clone. */
export class IndexedDbKeyValueStore<V> implements KeyValueStore<V> {
  constructor(
    private readonly store: IdbStoreName,
    private readonly dbName = "trailmark",
    private readonly factory: IDBFactory = globalThis.indexedDB,
  ) {
    if (this.factory === undefined) throw new Error("IndexedDB is not available in this environment");
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await openDb(this.dbName, this.factory);
    return db.transaction(this.store, mode).objectStore(this.store);
  }

  async get(key: string): Promise<V | undefined> {
    return request((await this.tx("readonly")).get(key)) as Promise<V | undefined>;
  }
  async set(key: string, value: V): Promise<void> {
    await request((await this.tx("readwrite")).put(value, key));
  }
  async delete(key: string): Promise<void> {
    await request((await this.tx("readwrite")).delete(key));
  }
  async keys(): Promise<string[]> {
    return (await request((await this.tx("readonly")).getAllKeys())).map(String);
  }
  async clear(): Promise<void> {
    await request((await this.tx("readwrite")).clear());
  }
}
