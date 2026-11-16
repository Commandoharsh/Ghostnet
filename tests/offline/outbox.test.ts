/**
 * Outbox tests — tests/offline/outbox.test.ts
 *
 * The test runner is Node.js (node:test) which has no browser globals.
 * This file installs a faithful in-memory IndexedDB fake before importing the
 * outbox module so that every code path in outbox.ts can be exercised without
 * a browser.
 *
 * The fake faithfully reproduces:
 *   - Versioned open: onupgradeneeded / onsuccess / onerror / onblocked
 *   - IDBVersionChangeEvent.oldVersion and .newVersion
 *   - request.result set to the live IDBDatabase before onupgradeneeded fires
 *     (required: outbox.ts reads request.result inside the upgrade handler)
 *   - request.transaction set to the upgrade transaction
 *   - Object store creation, absence, deletion, re-creation within an upgrade
 *   - Cursor iteration (for the rescue path in rebuildStoreInUpgrade)
 *   - getAll, put, delete, count on object stores
 *   - Transactions (readwrite / readonly) with oncomplete / onerror
 *   - Upgrade-blocked simulation
 *   - Non-upgrade transactions auto-commit via setImmediate
 *   - Upgrade transactions do NOT auto-commit — their lifecycle is controlled
 *     by the fake's open() path, mirroring real IDB spec behaviour
 */

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal in-process IndexedDB fake
// ---------------------------------------------------------------------------

type IDBRecord = Record<string, unknown>;

interface FakeStore {
  keyPath: string;
  records: Map<string, IDBRecord>;
}

interface FakeDb {
  name: string;
  version: number;
  /** Live object store map — mutations during upgrade are visible immediately. */
  stores: Map<string, FakeStore>;
  openConnections: number;
}

/** Global registry of all fake databases by name. */
const fakeRegistry = new Map<string, FakeDb>();

/** Set to true to make the next open() fire onblocked instead of upgrading. */
let simulateBlocked = false;

function getOrCreateFakeDb(name: string): FakeDb {
  let db = fakeRegistry.get(name);
  if (!db) {
    db = { name, version: 0, stores: new Map(), openConnections: 0 };
    fakeRegistry.set(name, db);
  }
  return db;
}

function dropFakeDb(name: string): void {
  fakeRegistry.delete(name);
}

// ---------------------------------------------------------------------------
// Fake IDB object implementations
// ---------------------------------------------------------------------------

class FakeIDBObjectStore {
  constructor(private readonly fakeStore: FakeStore) {}

  get keyPath(): string {
    return this.fakeStore.keyPath;
  }

  count(): FakeIDBRequest<number> {
    const req = new FakeIDBRequest<number>();
    setImmediate(() => {
      req.result = this.fakeStore.records.size;
      req.onsuccess?.({ target: req } as unknown as Event);
    });
    return req;
  }

  getAll(): FakeIDBRequest<IDBRecord[]> {
    const req = new FakeIDBRequest<IDBRecord[]>();
    setImmediate(() => {
      req.result = Array.from(this.fakeStore.records.values());
      req.onsuccess?.({ target: req } as unknown as Event);
    });
    return req;
  }

  put(record: IDBRecord): FakeIDBRequest<string> {
    const key = record[this.fakeStore.keyPath] as string;
    this.fakeStore.records.set(key, record);
    const req = new FakeIDBRequest<string>();
    req.result = key;
    // put inside a readwrite transaction fires synchronously; oncomplete
    // is on the transaction, not here.
    return req;
  }

  delete(key: string): FakeIDBRequest<undefined> {
    this.fakeStore.records.delete(key);
    return new FakeIDBRequest<undefined>();
  }

  openCursor(): FakeIDBRequest<IDBCursorWithValue | null> {
    const req = new FakeIDBRequest<IDBCursorWithValue | null>();
    const values = Array.from(this.fakeStore.records.values());
    let index = 0;

    const advance = (): void => {
      if (index < values.length) {
        const value = values[index++];
        const cursor = {
          value,
          continue: () => setImmediate(advance),
        } as unknown as IDBCursorWithValue;
        req.result = cursor;
        req.onsuccess?.({ target: req } as unknown as Event);
      } else {
        req.result = null;
        req.onsuccess?.({ target: req } as unknown as Event);
      }
    };

    setImmediate(advance);
    return req;
  }
}

class FakeIDBRequest<T = unknown> {
  result: T = undefined as unknown as T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  transaction: FakeIDBTransaction | null = null;
}

class FakeIDBTransaction {
  oncomplete: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;

  private _aborted = false;
  private _commitScheduled = false;

  constructor(
    public readonly db: FakeIDBDatabase,
    /**
     * storeNames lists the stores that are accessible via this transaction.
     * For upgrade transactions this is kept in sync with fakeDb.stores
     * via accessAllStores=true so that newly-created stores are reachable.
     */
    private readonly storeNamesSnapshot: string[],
    private readonly mode: "readonly" | "readwrite" | "upgrade",
  ) {}

  objectStore(name: string): FakeIDBObjectStore {
    // Upgrade transactions can access any store that currently exists.
    if (this.mode === "upgrade") {
      const store = this.db._fakeDb.stores.get(name);
      if (!store) {
        throw new DOMException(
          `One of the specified object stores was not found.`,
          "NotFoundError",
        );
      }
      return new FakeIDBObjectStore(store);
    }

    if (!this.storeNamesSnapshot.includes(name)) {
      throw new DOMException(
        `One of the specified object stores was not found.`,
        "NotFoundError",
      );
    }
    const store = this.db._fakeDb.stores.get(name);
    if (!store) {
      throw new DOMException(
        `One of the specified object stores was not found.`,
        "NotFoundError",
      );
    }
    return new FakeIDBObjectStore(store);
  }

  abort(): void {
    this._aborted = true;
    setImmediate(() => this.onabort?.());
  }

  /**
   * Schedules auto-commit for non-upgrade transactions.
   * Called explicitly by FakeIDBDatabase.transaction() after the transaction
   * object is returned to the caller so that all synchronous request setup
   * happens before the commit fires.
   *
   * We defer two setImmediate ticks so that any setImmediate-based request
   * handlers (count, getAll, openCursor) complete before oncomplete fires.
   * This mirrors real IDB behaviour: the transaction does not commit until
   * all pending requests on it have settled.
   */
  _scheduleCommit(): void {
    if (this._commitScheduled || this._aborted) return;
    this._commitScheduled = true;
    // First setImmediate: lets request handlers that use setImmediate (e.g.
    // count, getAll) fire their onsuccess callbacks.
    // Second setImmediate: lets any work queued by those callbacks complete
    // (e.g. the abort() call in the full-queue path queues onabort here).
    setImmediate(() => {
      setImmediate(() => {
        if (!this._aborted) {
          this.oncomplete?.();
        }
      });
    });
  }
}

class FakeIDBDatabase {
  /** Exposed for the test helpers and transaction internals. */
  public _fakeDb: FakeDb;

  constructor(fakeDb: FakeDb) {
    this._fakeDb = fakeDb;
  }

  get objectStoreNames(): DOMStringList {
    const names = Array.from(this._fakeDb.stores.keys());
    return {
      length: names.length,
      contains: (name: string) => names.includes(name),
      item: (index: number) => names[index] ?? null,
      [Symbol.iterator]: function* () { yield* names; },
    } as unknown as DOMStringList;
  }

  createObjectStore(name: string, options: { keyPath: string }): FakeIDBObjectStore {
    const store: FakeStore = { keyPath: options.keyPath, records: new Map() };
    this._fakeDb.stores.set(name, store);
    return new FakeIDBObjectStore(store);
  }

  deleteObjectStore(name: string): void {
    this._fakeDb.stores.delete(name);
  }

  transaction(
    storeNames: string | string[],
    mode: "readonly" | "readwrite" = "readonly",
  ): FakeIDBTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];

    for (const name of names) {
      if (!this._fakeDb.stores.has(name)) {
        throw new DOMException(
          `One of the specified object stores was not found.`,
          "NotFoundError",
        );
      }
    }

    const tx = new FakeIDBTransaction(this, names, mode);
    tx._scheduleCommit();
    return tx;
  }

  close(): void {
    if (this._fakeDb.openConnections > 0) {
      this._fakeDb.openConnections--;
    }
  }
}

class FakeIDBOpenDBRequest extends FakeIDBRequest<FakeIDBDatabase> {
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  onblocked: (() => void) | null = null;
  override transaction: FakeIDBTransaction | null = null;
}

/** Fake indexedDB global — installed before the module is imported. */
const fakeIndexedDB = {
  open(name: string, version: number): FakeIDBOpenDBRequest {
    const req = new FakeIDBOpenDBRequest();
    const fakeDb = getOrCreateFakeDb(name);

    setImmediate(() => {
      if (simulateBlocked) {
        simulateBlocked = false;
        req.onblocked?.();
        return;
      }

      const oldVersion = fakeDb.version;

      if (version > oldVersion) {
        // --- Upgrade path ---
        // Build the live database wrapper and upgrade transaction.
        const liveDb = new FakeIDBDatabase(fakeDb);
        const upgradeTx = new FakeIDBTransaction(
          liveDb,
          Array.from(fakeDb.stores.keys()), // snapshot of stores at upgrade start
          "upgrade",
        );

        // Real IDB: request.result is the connection BEFORE onupgradeneeded.
        req.result = liveDb;
        req.transaction = upgradeTx;

        const versionChangeEvent = {
          oldVersion,
          newVersion: version,
          target: req,
        } as unknown as IDBVersionChangeEvent;

        // Fire the upgrade handler synchronously (within this setImmediate).
        req.onupgradeneeded?.(versionChangeEvent);

        // The upgrade handler in outbox.ts may queue async IDB requests
        // (openCursor chains for the rescue path).  We must wait for all of
        // those setImmediate/microtask chains to drain before firing onsuccess.
        //
        // Strategy: schedule onsuccess after a short delay that lets all
        // pending setImmediate callbacks resolve.  Using setImmediate twice
        // gives one full "event loop turn" after the last cursor advance.
        // For the rescue path with multiple cursor hops we use a small
        // setTimeout to ensure all setImmediate chains complete first.
        setTimeout(() => {
          fakeDb.version = version;
          fakeDb.openConnections++;
          // Create a fresh wrapper so onsuccess sees the post-upgrade state.
          req.result = new FakeIDBDatabase(fakeDb);
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 20);
      } else {
        // --- No upgrade needed ---
        fakeDb.openConnections++;
        req.result = new FakeIDBDatabase(fakeDb);
        req.onsuccess?.({ target: req } as unknown as Event);
      }
    });

    return req;
  },
};

// Install the fake BEFORE importing the module under test.
(globalThis as unknown as Record<string, unknown>)["indexedDB"] = fakeIndexedDB;

// ---------------------------------------------------------------------------
// Module under test — imported AFTER the fake is installed.
// ---------------------------------------------------------------------------

import {
  DB_NAME,
  DB_VERSION,
  DB_VERSION_REPAIR,
  MAX_OUTBOX_SIZE,
  STORE,
  enqueueMessage,
  getQueuedMessages,
  openDb,
  type QueuedMessage,
} from "../../src/lib/offline/outbox.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMessage(
  id: string,
  state: QueuedMessage["state"] = "queued",
): QueuedMessage {
  return {
    id,
    senderId: "GN-TEST-001",
    destinationId: "broadcast",
    body: `Test message ${id}`,
    priority: "normal",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state,
  };
}

/** Drop the fake database so each test starts clean. */
function resetDb(): void {
  dropFakeDb(DB_NAME);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("outbox: constants are defined with expected values", () => {
  assert.equal(DB_NAME, "ghostnet-offline");
  assert.equal(STORE, "outbox");
  assert.ok(DB_VERSION >= 3, `DB_VERSION should be >= 3, got ${DB_VERSION}`);
  assert.ok(
    DB_VERSION_REPAIR > DB_VERSION,
    `DB_VERSION_REPAIR (${DB_VERSION_REPAIR}) must be greater than DB_VERSION (${DB_VERSION})`,
  );
  assert.ok(MAX_OUTBOX_SIZE > 0, "MAX_OUTBOX_SIZE must be positive");
});

test("outbox: first-time database creation creates the object store", async () => {
  resetDb();

  const db = await openDb();
  assert.ok(
    db.objectStoreNames.contains(STORE),
    `Expected "${STORE}" object store to exist after first open`,
  );
  db.close();
});

test("outbox: database opens at the correct version", async () => {
  resetDb();

  const db = await openDb() as unknown as FakeIDBDatabase;
  assert.equal(
    db._fakeDb.version,
    DB_VERSION,
    `Expected version ${DB_VERSION}, got ${db._fakeDb.version}`,
  );
  db.close();
});

test("outbox: reading an empty outbox returns an empty array", async () => {
  resetDb();

  const messages = await getQueuedMessages();
  assert.deepEqual(messages, []);
});

test("outbox: enqueueMessage persists and getQueuedMessages retrieves it", async () => {
  resetDb();

  const msg = makeMessage("outbox-msg-001");
  await enqueueMessage(msg);

  const rows = await getQueuedMessages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "outbox-msg-001");
  assert.equal(rows[0].body, "Test message outbox-msg-001");
  assert.equal(rows[0].state, "queued");
});

test("outbox: enqueueMessage overwrites an existing record with the same id (put semantics)", async () => {
  resetDb();

  const original = makeMessage("outbox-msg-dup");
  await enqueueMessage(original);

  const updated: QueuedMessage = { ...original, state: "failed" };
  await enqueueMessage(updated);

  const rows = await getQueuedMessages();
  assert.equal(rows.length, 1, "put should overwrite, not append");
  assert.equal(rows[0].state, "failed");
});

test("outbox: multiple distinct messages are all stored", async () => {
  resetDb();

  await enqueueMessage(makeMessage("outbox-multi-001"));
  await enqueueMessage(makeMessage("outbox-multi-002"));
  await enqueueMessage(makeMessage("outbox-multi-003"));

  const rows = await getQueuedMessages();
  assert.equal(rows.length, 3);
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [
    "outbox-multi-001",
    "outbox-multi-002",
    "outbox-multi-003",
  ]);
});

test("outbox: priority field is stored and retrieved correctly", async () => {
  resetDb();

  const critical: QueuedMessage = { ...makeMessage("outbox-prio-001"), priority: "critical" };
  const high: QueuedMessage = { ...makeMessage("outbox-prio-002"), priority: "high" };
  await enqueueMessage(critical);
  await enqueueMessage(high);

  const rows = await getQueuedMessages();
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("outbox-prio-001")?.priority, "critical");
  assert.equal(byId.get("outbox-prio-002")?.priority, "high");
});

test("outbox: database upgrade from v1 creates the outbox store", async () => {
  resetDb();

  // Install a v1 database without the outbox store — the broken initial state
  // that caused the reported NotFoundError.
  const fakeDbEntry = getOrCreateFakeDb(DB_NAME);
  fakeDbEntry.version = 1;
  // No stores.

  const db = await openDb();
  assert.ok(
    db.objectStoreNames.contains(STORE),
    "openDb must create the outbox store when upgrading from v1",
  );
  db.close();
});

test("outbox: database upgrade from v2 creates the outbox store", async () => {
  resetDb();

  // Simulate a v2 database that also never received the outbox store.
  const fakeDbEntry = getOrCreateFakeDb(DB_NAME);
  fakeDbEntry.version = 2;
  // No stores.

  const db = await openDb();
  assert.ok(
    db.objectStoreNames.contains(STORE),
    "openDb must create the outbox store when upgrading from v2",
  );
  db.close();
});

test("outbox: upgrade from v1 preserves messages already in the outbox store", async () => {
  resetDb();

  // v1 database that has the outbox store with an existing message.
  const fakeDbEntry = getOrCreateFakeDb(DB_NAME);
  fakeDbEntry.version = 1;
  const existingStore: FakeStore = {
    keyPath: "id",
    records: new Map([
      [
        "rescued-msg-001",
        makeMessage("rescued-msg-001") as unknown as IDBRecord,
      ],
    ]),
  };
  fakeDbEntry.stores.set(STORE, existingStore);

  const db = await openDb();
  assert.ok(db.objectStoreNames.contains(STORE));
  db.close();

  const rows = await getQueuedMessages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "rescued-msg-001");
});

test("outbox: v2-but-store-missing triggers repair upgrade and creates the store", async () => {
  resetDb();

  // Database is already at DB_VERSION but has no stores — the pathological
  // case the additional requirement specifically calls for.
  const fakeDbEntry = getOrCreateFakeDb(DB_NAME);
  fakeDbEntry.version = DB_VERSION;
  // No stores.

  // openDb must detect the missing store in onsuccess and recurse at
  // DB_VERSION_REPAIR, triggering a fresh onupgradeneeded.
  const db = await openDb();
  assert.ok(
    db.objectStoreNames.contains(STORE),
    "Repair upgrade must create the outbox store when it is absent at DB_VERSION",
  );
  db.close();
});

test("outbox: repair upgrade at DB_VERSION_REPAIR rescues messages from a foreign store", async () => {
  resetDb();

  // Database is at DB_VERSION with no "outbox" but with a "legacy-outbox"
  // store holding a recoverable message.  The rescue path should salvage it.
  const fakeDbEntry = getOrCreateFakeDb(DB_NAME);
  fakeDbEntry.version = DB_VERSION;
  const legacyStore: FakeStore = {
    keyPath: "id",
    records: new Map([
      [
        "legacy-msg-001",
        makeMessage("legacy-msg-001") as unknown as IDBRecord,
      ],
    ]),
  };
  fakeDbEntry.stores.set("legacy-outbox", legacyStore);
  // "outbox" is intentionally absent.

  const db = await openDb();
  assert.ok(db.objectStoreNames.contains(STORE), "outbox store must exist after repair");
  db.close();

  const rows = await getQueuedMessages();
  assert.equal(rows.length, 1, "rescued message must be in the new outbox");
  assert.equal(rows[0].id, "legacy-msg-001");
});

test("outbox: blocked upgrade rejects with a descriptive error", async () => {
  resetDb();

  simulateBlocked = true;

  await assert.rejects(
    () => openDb(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /blocked by another open tab/);
      return true;
    },
  );
});

test("outbox: opening db when indexedDB is unavailable rejects with a descriptive error", async () => {
  const original = (globalThis as unknown as Record<string, unknown>)["indexedDB"];
  (globalThis as unknown as Record<string, unknown>)["indexedDB"] = {
    open(): never {
      throw new TypeError("indexedDB is not available in this context");
    },
  };

  try {
    await assert.rejects(
      () => openDb(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /IndexedDB unavailable/);
        return true;
      },
    );
  } finally {
    (globalThis as unknown as Record<string, unknown>)["indexedDB"] = original;
  }
});

test("outbox: transaction on missing store name throws NotFoundError", async () => {
  resetDb();

  const db = await openDb() as unknown as FakeIDBDatabase;

  assert.throws(
    () => db.transaction("nonexistent-store", "readwrite"),
    (err: unknown) => {
      assert.ok(err instanceof DOMException);
      assert.equal((err as DOMException).name, "NotFoundError");
      return true;
    },
  );

  db.close();
});

test("outbox: enqueuing beyond MAX_OUTBOX_SIZE rejects without data loss", async () => {
  resetDb();

  // Warm up the db so the store exists.
  const initDb = await openDb() as unknown as FakeIDBDatabase;
  initDb.close();

  // Fill the store directly to the limit.
  const fakeDbEntry = getOrCreateFakeDb(DB_NAME);
  const store = fakeDbEntry.stores.get(STORE)!;
  for (let i = 0; i < MAX_OUTBOX_SIZE; i++) {
    const msg = makeMessage(`fill-msg-${String(i).padStart(4, "0")}`);
    store.records.set(msg.id, msg as unknown as IDBRecord);
  }

  await assert.rejects(
    () => enqueueMessage(makeMessage("overflow-msg")),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Outbox is full/);
      return true;
    },
  );

  // Existing messages must be intact.
  const rows = await getQueuedMessages();
  assert.equal(rows.length, MAX_OUTBOX_SIZE);
  assert.ok(
    !rows.some((r) => r.id === "overflow-msg"),
    "overflow message must not have been stored",
  );
});
