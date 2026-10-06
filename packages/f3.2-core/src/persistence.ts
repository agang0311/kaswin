/** Transactional browser persistence. Imports are data, never trusted verification evidence. */
import { check, unhex, integer } from './bytes.js';
export interface Stored<T> {
    revision: number;
    value: T;
}
export interface Store {
    get<T>(key: string): Promise<Stored<T> | null>;
    compareAndSet<T>(key: string, expectedRevision: number | null, value: T): Promise<Stored<T>>;
    remove(key: string, expectedRevision: number): Promise<void>;
    list<T>(prefix: string): Promise<Array<{
        key: string;
        record: Stored<T>;
    }>>;
}
export function namespace(profile: string, genesisTxId?: string): string {
    unhex(profile, 32);
    if (genesisTxId !== undefined)
        unhex(genesisTxId, 32);
    return [profile, genesisTxId ?? ''].join('/') + '/';
}
export class IndexedStore implements Store {
    private constructor(private db: IDBDatabase) { }
    static open(name = 'kaswin-r7-components', factory: IDBFactory = indexedDB): Promise<IndexedStore> {
        return new Promise((resolve, reject) => {
            const req = factory.open(name, 1);
            req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('records'))
                req.result.createObjectStore('records'); };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IDB_UPGRADE_BLOCKED'));
            req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(new IndexedStore(db)); };
        });
    }
    close(): void { this.db.close(); }
    get<T>(key: string): Promise<Stored<T> | null> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readonly'), r = tx.objectStore('records').get(key);
            let result: Stored<T> | null = null;
            r.onsuccess = () => { result = r.result ?? null; };
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('IDB_ABORT'));
        });
    }
    compareAndSet<T>(key: string, expectedRevision: number | null, value: T): Promise<Stored<T>> {
        if (expectedRevision !== null)
            integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1);
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readwrite'), store = tx.objectStore('records'), req = store.get(key);
            let result: Stored<T>;
            let cause: unknown;
            req.onsuccess = () => {
                try {
                    const prev = req.result as Stored<T> | undefined;
                    check((prev?.revision ?? null) === expectedRevision, 'STALE_CACHE_REVISION');
                    result = { revision: (prev?.revision ?? -1) + 1, value };
                    store.put(result, key);
                }
                catch (e) {
                    cause = e;
                    tx.abort();
                }
            };
            tx.oncomplete = () => resolve(result!);
            tx.onabort = () => reject(cause ?? tx.error ?? new Error('IDB_ABORT'));
            tx.onerror = () => reject(cause ?? tx.error);
        });
    }
    remove(key: string, expectedRevision: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readwrite'), store = tx.objectStore('records'), r = store.get(key);
            let cause: unknown;
            r.onsuccess = () => { try {
                check(r.result?.revision === expectedRevision, 'STALE_CACHE_REVISION');
                store.delete(key);
            }
            catch (e) {
                cause = e;
                tx.abort();
            } };
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(cause ?? tx.error);
            tx.onerror = () => reject(cause ?? tx.error);
        });
    }
    list<T>(prefix: string): Promise<Array<{
        key: string;
        record: Stored<T>;
    }>> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readonly'), r = tx.objectStore('records').openCursor(), out: Array<{
                key: string;
                record: Stored<T>;
            }> = [];
            r.onsuccess = () => { const c = r.result; if (!c)
                return; if (typeof c.key === 'string' && c.key.startsWith(prefix))
                out.push({ key: c.key, record: c.value }); c.continue(); };
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
}
