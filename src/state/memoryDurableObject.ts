/**
 * In-memory Durable Object storage for unit tests.
 *
 * Supports get/put/delete/list and storage.transaction so SessionDurableObject
 * and SessionRegistryDurableObject can be exercised without Miniflare.
 * Cloudflare list `end` is exclusive.
 */

type MemoryGet = {
  (key: string): Promise<unknown>;
  (keys: string[]): Promise<Map<string, unknown>>;
};

type MemoryPut = {
  (key: string, value: unknown): Promise<void>;
  (entries: Record<string, unknown>): Promise<void>;
};

type MemoryDelete = {
  (key: string): Promise<boolean>;
  (keys: string[]): Promise<number>;
};

interface MemoryStorageApi {
  get: MemoryGet;
  put: MemoryPut;
  delete: MemoryDelete;
  list: (options?: {
    start?: string;
    end?: string;
    prefix?: string;
  }) => Promise<Map<string, unknown>>;
}

export function createMemoryDurableObjectState(
  idString = "opaque-do-id",
  initial: Record<string, unknown> = {},
): DurableObjectState {
  const store = new Map<string, unknown>(Object.entries(initial));

  const storage: MemoryStorageApi & {
    transaction: <T>(closure: (txn: MemoryStorageApi) => Promise<T>) => Promise<T>;
  } = {
    get: (async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        const result = new Map<string, unknown>();
        for (const key of keyOrKeys) {
          if (store.has(key)) result.set(key, store.get(key));
        }
        return result;
      }
      return store.get(keyOrKeys);
    }) as MemoryGet,
    put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === "string") {
        store.set(keyOrEntries, value);
        return;
      }
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        store.set(key, entry);
      }
    }) as MemoryPut,
    delete: (async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        let count = 0;
        for (const key of keyOrKeys) {
          if (store.delete(key)) count += 1;
        }
        return count;
      }
      return store.delete(keyOrKeys);
    }) as MemoryDelete,
    list: async (options?: { start?: string; end?: string; prefix?: string }) => {
      const result = new Map<string, unknown>();
      const keys = [...store.keys()].sort();
      for (const key of keys) {
        if (options?.prefix && !key.startsWith(options.prefix)) continue;
        if (options?.start && key < options.start) continue;
        if (options?.end && key >= options.end) continue;
        result.set(key, store.get(key));
      }
      return result;
    },
    transaction: async <T>(closure: (txn: MemoryStorageApi) => Promise<T>): Promise<T> => {
      const snapshot = new Map(store);
      try {
        const txn: MemoryStorageApi = {
          get: ((keyOrKeys: string | string[]) => storage.get(keyOrKeys as string[])) as MemoryGet,
          put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
            typeof keyOrEntries === "string"
              ? storage.put(keyOrEntries, value)
              : storage.put(keyOrEntries)) as MemoryPut,
          delete: ((keyOrKeys: string | string[]) =>
            storage.delete(keyOrKeys as string[])) as MemoryDelete,
          list: (options) => storage.list(options),
        };
        return await closure(txn);
      } catch (error) {
        store.clear();
        for (const [key, entry] of snapshot) store.set(key, entry);
        throw error;
      }
    },
  };

  return {
    id: { toString: () => idString },
    storage,
  } as unknown as DurableObjectState;
}
