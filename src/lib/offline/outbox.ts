/**
 * Offline outbox — persistent message queue backed by IndexedDB.
 *
 * Version history
 * ───────────────
 * v1  Initial schema.  The "outbox" object store may or may not have been
 *     created depending on whether the page survived the first
 *     onupgradeneeded event (browser crash, force-quit, storage quota hit).
 *
 * v2  Intermediate version that may exist in the wild.  Same schema intent
 *     as v1 but created by a build that incremented the version without
 *     guaranteeing store creation.  The "outbox" store can still be absent.
 *
 * v3  Current target.  onupgradeneeded always creates "outbox" when missing,
 *     regardless of oldVersion.  If the store was absent at v1 or v2 the
 *     upgrade transaction creates it here.
 *
 * Recovery for v3-but-store-missing
 * ───────────────────────────────────
 * If, after successfully opening at v3, onsuccess detects the store is still
 * absent (pathological: aborted upgrade transaction, browser bug, concurrent
 * write from another tab that stomped the schema), openDb reopens the
 * database at v4.  The onupgradeneeded handler at v4 rescues any queued
 * messages found in other stores before rebuilding "outbox".  The database
 * is never deleted as a recovery shortcut.
 */

export type QueueState = "queued" | "failed";

export interface QueuedMessage {
  id: string;
  senderId: string;
  destinationId: string;
  body: string;
  priority: "critical" | "high" | "normal";
  createdAt: string;
  expiresAt: string;
  state: QueueState;
}

export const DB_NAME = "ghostnet-offline";
export const STORE = "outbox";

/** Current target schema version. */
export const DB_VERSION = 3;

/**
 * Emergency bump version used when the database is already at DB_VERSION but
 * the required object store is still absent.  Incrementing the version forces
 * a fresh onupgradeneeded where we can safely call createObjectStore.
 */
export const DB_VERSION_REPAIR = 4;

/** Hard cap on queued messages to prevent unbounded memory/disk growth. */
export const MAX_OUTBOX_SIZE = 500;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Drain every record that looks like a QueuedMessage from every object store
 * in an upgrade transaction and return them.  Used by the repair path to
 * preserve messages that exist in a malformed database before the store is
 * recreated.
 *
 * This runs synchronously within an IDBTransaction (upgrade) and returns a
 * Promise that resolves once all cursors have finished.
 */
function rescueRecordsFromTransaction(
  tx: IDBTransaction,
): Promise<QueuedMessage[]> {
  return new Promise<QueuedMessage[]>((resolve) => {
    const rescued: QueuedMessage[] = [];
    const db = tx.db;
    const storeNames = Array.from(db.objectStoreNames);

    if (storeNames.length === 0) {
      resolve(rescued);
      return;
    }

    let pending = storeNames.length;

    for (const name of storeNames) {
      let store: IDBObjectStore;
      try {
        store = tx.objectStore(name);
      } catch {
        // Store not accessible in this transaction — skip.
        pending--;
        if (pending === 0) resolve(rescued);
        continue;
      }

      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result as IDBCursorWithValue | null;
        if (cursor) {
          const rec = cursor.value as unknown;
          // Accept only records that have the minimum QueuedMessage shape.
          if (
            rec !== null &&
            typeof rec === "object" &&
            typeof (rec as Record<string, unknown>)["id"] === "string" &&
            typeof (rec as Record<string, unknown>)["body"] === "string"
          ) {
            rescued.push(rec as QueuedMessage);
          }
          cursor.continue();
        } else {
          pending--;
          if (pending === 0) resolve(rescued);
        }
      };
      req.onerror = () => {
        pending--;
        if (pending === 0) resolve(rescued);
      };
    }
  });
}

/**
 * Rebuild the "outbox" store inside an active upgrade transaction.
 *
 * Steps:
 *   1. Rescue any QueuedMessage-shaped records from every accessible store.
 *   2. Delete all existing stores (the schema is malformed; start clean).
 *   3. Create a fresh "outbox" store with the correct keyPath.
 *   4. Re-insert rescued records so no data is lost.
 */
async function rebuildStoreInUpgrade(tx: IDBTransaction): Promise<void> {
  const rescued = await rescueRecordsFromTransaction(tx);

  const db = tx.db;
  const storeNames = Array.from(db.objectStoreNames);
  for (const name of storeNames) {
    db.deleteObjectStore(name);
  }

  const fresh = db.createObjectStore(STORE, { keyPath: "id" });
  for (const record of rescued) {
    fresh.put(record);
  }
}

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------

/**
 * Open the IndexedDB database, upgrading the schema when necessary.
 *
 * The caller is responsible for closing the returned IDBDatabase (use
 * try/finally).
 *
 * Throws if:
 *   - IndexedDB is unavailable in this environment.
 *   - The upgrade is blocked by another tab.
 *   - The database cannot be opened due to a browser error.
 *   - The "outbox" store remains absent after all recovery attempts.
 */
export function openDb(
  overrideVersion?: number,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const targetVersion = overrideVersion ?? DB_VERSION;

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, targetVersion);
    } catch (err) {
      reject(new Error(`IndexedDB unavailable: ${String(err)}`));
      return;
    }

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (!db.objectStoreNames.contains(STORE)) {
        if (oldVersion === 0) {
          // Fresh install — create the store.
          db.createObjectStore(STORE, { keyPath: "id" });
        } else {
          // The store is absent in an existing database (v1, v2, or v3
          // with a failed prior upgrade).  Rescue whatever is there, then
          // rebuild the schema.  rebuildStoreInUpgrade is async but runs
          // operations on the same upgrade transaction before it auto-commits,
          // which is valid because the upgrade transaction does not commit
          // until all pending IDB requests on it settle.
          const upgradeTx = request.transaction!;
          rebuildStoreInUpgrade(upgradeTx).catch((err: unknown) => {
            // If rescue fails, still attempt to create a minimal outbox store
            // so the upgrade transaction does not leave the database without it.
            if (!db.objectStoreNames.contains(STORE)) {
              db.createObjectStore(STORE, { keyPath: "id" });
            }
            console.warn("GhostNet outbox rescue encountered an error:", err);
          });
        }
      }
      // If the store already exists, the upgrade is a no-op for the schema.
    };

    request.onsuccess = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE)) {
        // Store is still missing after the upgrade completed.  This is the
        // pathological case: the database is at DB_VERSION but onupgradeneeded
        // either did not fire or its transaction was aborted before our store
        // creation committed.
        //
        // Strategy: close this connection and reopen at DB_VERSION_REPAIR.
        // That will trigger onupgradeneeded again (oldVersion = targetVersion,
        // newVersion = DB_VERSION_REPAIR) where we can safely rebuild.
        db.close();

        if (targetVersion >= DB_VERSION_REPAIR) {
          // We already tried the repair version and the store is still absent.
          // Something is fundamentally wrong with this IndexedDB instance
          // (browser bug, quota enforcement, corrupted storage).  Surface a
          // clear, actionable error.
          reject(
            new Error(
              `IndexedDB object store "${STORE}" is absent in "${DB_NAME}" ` +
                `even after schema repair (reached version ${targetVersion}). ` +
                `Clear site data for this origin to recover.`,
            ),
          );
          return;
        }

        // Recurse once at the repair version.
        openDb(DB_VERSION_REPAIR).then(resolve, reject);
        return;
      }

      resolve(db);
    };

    request.onerror = () => {
      reject(
        new Error(
          `Failed to open IndexedDB "${DB_NAME}" at version ${targetVersion}: ` +
            `${request.error?.message ?? "unknown error"}`,
        ),
      );
    };

    // Another tab holds the database open at an older version.  The upgrade
    // cannot proceed until that connection closes.
    request.onblocked = () => {
      reject(
        new Error(
          `IndexedDB upgrade for "${DB_NAME}" is blocked by another open tab. ` +
            `Close other GhostNet tabs and retry.`,
        ),
      );
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function enqueueMessage(message: QueuedMessage): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch (err) {
        reject(new Error(`Cannot open outbox transaction: ${String(err)}`));
        return;
      }

      const objectStore = tx.objectStore(STORE);
      const countReq = objectStore.count();

      countReq.onsuccess = () => {
        const count = countReq.result as number;
        if (count >= MAX_OUTBOX_SIZE) {
          tx.abort();
          reject(
            new Error(
              `Outbox is full (${MAX_OUTBOX_SIZE} messages). ` +
                `Sync or discard existing messages before enqueuing new ones.`,
            ),
          );
          return;
        }
        objectStore.put(message);
      };

      countReq.onerror = () =>
        reject(new Error(`Count check failed: ${countReq.error?.message ?? "unknown"}`));

      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(new Error(`Outbox write failed: ${tx.error?.message ?? "unknown"}`));
      // onabort is intentionally not wired to reject here: the full-queue
      // path calls tx.abort() after already calling reject(), so a second
      // rejection would be swallowed by the Promise anyway, but we avoid the
      // noise.
    });
  } finally {
    db.close();
  }
}

export async function getQueuedMessages(): Promise<QueuedMessage[]> {
  const db = await openDb();
  try {
    return await new Promise<QueuedMessage[]>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, "readonly");
      } catch (err) {
        reject(new Error(`Cannot open outbox transaction: ${String(err)}`));
        return;
      }

      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as QueuedMessage[]);
      req.onerror = () =>
        reject(new Error(`Outbox read failed: ${req.error?.message ?? "unknown"}`));
    });
  } finally {
    db.close();
  }
}

async function deleteQueuedMessage(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch (err) {
        reject(new Error(`Cannot open outbox transaction: ${String(err)}`));
        return;
      }

      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(new Error(`Outbox delete failed: ${tx.error?.message ?? "unknown"}`));
    });
  } finally {
    db.close();
  }
}

async function updateQueuedMessage(message: QueuedMessage): Promise<void> {
  await enqueueMessage(message);
}

export async function syncOutbox(): Promise<{
  sent: number;
  pending: number;
  failed: number;
}> {
  const rows = await getQueuedMessages();
  let sent = 0;
  let failed = 0;

  for (const message of rows) {
    if (Date.parse(message.expiresAt) <= Date.now()) {
      await deleteQueuedMessage(message.id);
      continue;
    }

    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      if (response.ok) {
        await deleteQueuedMessage(message.id);
        sent++;
      } else {
        await updateQueuedMessage({ ...message, state: "failed" });
        failed++;
      }
    } catch {
      await updateQueuedMessage({ ...message, state: "failed" });
      failed++;
    }
  }

  const remaining = (await getQueuedMessages()).length;
  return { sent, pending: remaining, failed };
}
