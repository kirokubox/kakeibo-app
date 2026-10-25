import { buildBackup } from "./backup.js";
import { DB_NAME, DB_VERSION, SETTINGS_KEY, SETTINGS_STORE, TRANSACTION_INDEXES, defaultSettings } from "./constants.js";
import { planUpgrade } from "./dbMigration.js";
import { nowIso } from "./dateUtils.js";
import { buildSeedCategories } from "./seedCategories.js";
import { DATA_STORE_NAMES } from "./types.js";
import type { BackupFile, Base, DataSet, DataStoreName, DataStoreRecords, Settings, Transaction } from "./types.js";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 版1：全ストアを作る。以後の版では「無いものだけ足す」形で、既存のストアとデータには触れない（計画は dbMigration.ts）
      const plan = planUpgrade(Array.from(db.objectStoreNames));
      for (const name of plan.create) {
        const store = db.createObjectStore(name, { keyPath: "id" });
        if (name === "transactions") {
          for (const index of TRANSACTION_INDEXES) store.createIndex(index, index, { unique: false });
        }
      }
      if (plan.createSettings) db.createObjectStore(SETTINGS_STORE);
    };
    req.onsuccess = () => {
      // 新しい版が別タブで開かれたら、古い接続を閉じて更新を妨げない
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error("別のタブを閉じてから、アプリを開き直してください。"));
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("保存が取り消されました"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 新しいレコードの共通項目 */
export function newBase(now: string = nowIso()): Base {
  return { id: newId(), createdAt: now, updatedAt: now, deletedAt: null };
}

/** UUID。http のLAN接続など randomUUID が無い環境では代替する */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 論理削除されていないものだけにする（画面と計算で使う） */
export function activeOnly<T extends Base>(records: T[]): T[] {
  return records.filter((r) => r.deletedAt === null);
}

/** ストアの全レコード（論理削除したものも含む） */
export async function getAll<K extends DataStoreName>(store: K): Promise<DataStoreRecords[K][]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return request(tx.objectStore(store).getAll() as IDBRequest<DataStoreRecords[K][]>);
}

/**
 * 期間（start〜end、両端を含む）の取引を date の索引で読む（論理削除したものも含むので、画面側で activeOnly する）。
 * 約1万3千件を毎回全部読まないための読み方。
 */
export async function getTransactionsInRange(start: string, end: string): Promise<Transaction[]> {
  const db = await openDb();
  const tx = db.transaction("transactions", "readonly");
  return request(tx.objectStore("transactions").index("date").getAll(IDBKeyRange.bound(start, end)) as IDBRequest<Transaction[]>);
}

/**
 * ある資産が出てくる取引（accountId か toAccountId がその資産）を、2つの索引で読む。
 * 論理削除したものも含むので、画面側で activeOnly する。資産の明細の残高の動きに使う。
 */
export async function getAccountTransactions(accountId: string): Promise<Transaction[]> {
  const db = await openDb();
  const tx = db.transaction("transactions", "readonly");
  const os = tx.objectStore("transactions");
  const [from, to] = await Promise.all([
    request(os.index("accountId").getAll(IDBKeyRange.only(accountId)) as IDBRequest<Transaction[]>),
    request(os.index("toAccountId").getAll(IDBKeyRange.only(accountId)) as IDBRequest<Transaction[]>),
  ]);
  const seen = new Set<string>();
  const merged: Transaction[] = [];
  for (const t of [...from, ...to]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    merged.push(t);
  }
  return merged;
}

/** 書き込み。書くたびに updatedAt を現在時刻にする（将来の同期に備える） */
export async function saveRecord<K extends DataStoreName>(store: K, record: DataStoreRecords[K]): Promise<DataStoreRecords[K]> {
  const stamped = { ...record, updatedAt: nowIso() };
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(stamped);
  await done(tx);
  return stamped;
}

/** 複数のレコードを1つのトランザクションで書く（並べ替えなど。途中で失敗したら何も書かない）。updatedAt は現在時刻にする */
export async function saveRecords<K extends DataStoreName>(store: K, records: DataStoreRecords[K][]): Promise<void> {
  if (records.length === 0) return;
  const now = nowIso();
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const r of records) os.put({ ...r, updatedAt: now });
  await done(tx);
}

/**
 * 複数のストアのレコードを1つのトランザクションで書く（明細と繰り返しを同時に保存するときなど。途中で失敗したら何も書かない）。
 * 書くたびに updatedAt を現在時刻にする
 */
export async function saveStores(records: { [K in DataStoreName]?: DataStoreRecords[K][] }): Promise<void> {
  const names = DATA_STORE_NAMES.filter((n) => (records[n]?.length ?? 0) > 0);
  if (names.length === 0) return;
  const now = nowIso();
  const db = await openDb();
  const tx = db.transaction([...names], "readwrite");
  for (const name of names) {
    const os = tx.objectStore(name);
    for (const r of records[name] ?? []) os.put({ ...r, updatedAt: now });
  }
  await done(tx);
}

/** 論理削除。deletedAt と updatedAt に現在時刻を入れる（データ自体は消さない） */
export async function softDelete<K extends DataStoreName>(store: K, id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  const getReq = os.get(id);
  getReq.onsuccess = () => {
    const current = getReq.result as Base | undefined;
    if (!current || current.deletedAt !== null) return;
    const now = nowIso();
    os.put({ ...current, deletedAt: now, updatedAt: now });
  };
  await done(tx);
}

/** 全ストアの中身を1つのトランザクションで読む（書き出し用。論理削除したものも含む） */
export async function getAllData(): Promise<DataSet> {
  const db = await openDb();
  const tx = db.transaction([...DATA_STORE_NAMES], "readonly");
  const entries = await Promise.all(DATA_STORE_NAMES.map(async (name) => [name, await request(tx.objectStore(name).getAll())] as const));
  return Object.fromEntries(entries) as unknown as DataSet;
}

export async function getSettings(): Promise<Settings> {
  const db = await openDb();
  const tx = db.transaction(SETTINGS_STORE, "readonly");
  const stored = (await request(tx.objectStore(SETTINGS_STORE).get(SETTINGS_KEY))) as Partial<Settings> | undefined;
  // 足りない項目は初期値で補う（将来、設定の項目を増やしても古い保存データで動くように）
  return { ...defaultSettings(), ...(stored ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SETTINGS_STORE, "readwrite");
  tx.objectStore(SETTINGS_STORE).put(settings, SETTINGS_KEY);
  await done(tx);
}

/** 分類が1件も無いとき（論理削除したものも数える）だけ、初期の分類を入れる。判定と書き込みは同じトランザクション */
export async function seedCategoriesIfEmpty(): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction("categories", "readwrite");
  const os = tx.objectStore("categories");
  let seeded = false;
  const countReq = os.count();
  countReq.onsuccess = () => {
    if (countReq.result > 0) return;
    for (const c of buildSeedCategories()) os.put(c);
    seeded = true;
  };
  await done(tx);
  return seeded;
}

/**
 * 書き出し：全データ＋設定のバックアップを作る。
 * ファイルの中の settings.lastBackupAt は書き出し時刻にしてあり、返す settings（同じ内容）を呼び出し側が saveSettings で保存する。
 */
export async function exportBackup(): Promise<{ backup: BackupFile; settings: Settings }> {
  const [data, settings] = await Promise.all([getAllData(), getSettings()]);
  const exportedAt = nowIso();
  const updated: Settings = { ...settings, lastBackupAt: exportedAt };
  return { backup: buildBackup(data, updated, exportedAt), settings: updated };
}

/**
 * 追加インポートの書き込み。全ストアを1つのトランザクションで書き、途中で失敗したら何も書かない。
 * 読み込んだ側の updatedAt はそのまま保つ（書き込み時刻で上書きしない）。既存データは消さない。
 */
export async function writeImported(records: { [K in DataStoreName]: DataStoreRecords[K][] }): Promise<void> {
  const names = DATA_STORE_NAMES.filter((n) => records[n].length > 0);
  if (names.length === 0) return;
  const db = await openDb();
  const tx = db.transaction([...names], "readwrite");
  const finished = done(tx);
  try {
    for (const name of names) {
      const os = tx.objectStore(name);
      for (const r of records[name]) os.put(r);
    }
  } catch (error) {
    tx.abort();
    await finished.catch(() => undefined);
    throw error;
  }
  await finished;
}

export type PersistenceState = "granted" | "denied" | "unsupported";

export async function getPersistenceState(): Promise<PersistenceState> {
  try {
    if (!navigator.storage?.persisted) return "unsupported";
    return (await navigator.storage.persisted()) ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}

/** 永続ストレージ（ブラウザが自動でデータを消さない扱い）を求める。拒否されても動く */
export async function requestPersistentStorage(): Promise<PersistenceState> {
  try {
    if (!navigator.storage?.persist) return "unsupported";
    if (await navigator.storage.persisted()) return "granted";
    return (await navigator.storage.persist()) ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}
