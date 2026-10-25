import { DATA_STORE_NAMES } from "./types.js";
import type { BackupFile, Base, DataSet, DataStoreName, DataStoreRecords } from "./types.js";

// 追加インポートの差分計算（データ管理方針どおり：既存データを消さない）。
// 同じIDの比較は updatedAt（後のほうが新しい）。論理削除は updatedAt が更新されるので、
// 「削除した」という変更も新しい側が勝つ。

/** 既存データの id → updatedAt */
export type ExistingIndex = { [K in DataStoreName]: Map<string, string> };

export interface StorePlan<T extends Base> {
  /** 既存にないID：新しく足す */
  add: T[];
  /** 同じIDで読み込む側が新しい：更新する */
  update: T[];
  /** 同じIDで updatedAt が同じ：飛ばす */
  same: number;
  /** 同じIDで既存の方が新しい：飛ばす */
  older: number;
  /** 読み込む側の件数 */
  total: number;
}

export type ImportPlan = { [K in DataStoreName]: StorePlan<DataStoreRecords[K]> };

export interface ImportChoice {
  /** 新しく足す */
  add: boolean;
  /** 同じIDで読み込む側が新しいものを更新する */
  update: boolean;
}

export function indexExisting(data: DataSet): ExistingIndex {
  const idx = {} as ExistingIndex;
  for (const name of DATA_STORE_NAMES) {
    const m = new Map<string, string>();
    for (const r of data[name] as Base[]) m.set(r.id, r.updatedAt);
    idx[name] = m;
  }
  return idx;
}

function planStore<T extends Base>(incoming: T[], existing: Map<string, string>): StorePlan<T> {
  const plan: StorePlan<T> = { add: [], update: [], same: 0, older: 0, total: incoming.length };
  for (const rec of incoming) {
    const current = existing.get(rec.id);
    if (current === undefined) {
      plan.add.push(rec);
      continue;
    }
    const a = Date.parse(rec.updatedAt);
    const b = Date.parse(current);
    if (a > b) plan.update.push(rec);
    else if (a === b) plan.same++;
    else plan.older++;
  }
  return plan;
}

/** 検証済みのバックアップと既存データから、ストアごとの差分を出す */
export function planImport(backup: BackupFile, existing: ExistingIndex): ImportPlan {
  const plan = {} as Record<DataStoreName, StorePlan<Base>>;
  for (const name of DATA_STORE_NAMES) {
    plan[name] = planStore(backup[name] as Base[], existing[name]);
  }
  return plan as unknown as ImportPlan;
}

export interface ImportTotals {
  total: number;
  add: number;
  update: number;
  skipped: number;
}

export function totalsOf(plan: ImportPlan): ImportTotals {
  const t: ImportTotals = { total: 0, add: 0, update: 0, skipped: 0 };
  for (const name of DATA_STORE_NAMES) {
    const p = plan[name];
    t.total += p.total;
    t.add += p.add.length;
    t.update += p.update.length;
    t.skipped += p.same + p.older;
  }
  return t;
}

/** 本人の選択にしたがって、実際に書き込むレコードを選ぶ（updatedAt は読み込んだ側のまま保つ） */
export function recordsToWrite(plan: ImportPlan, choice: ImportChoice): { [K in DataStoreName]: DataStoreRecords[K][] } {
  const out = {} as Record<DataStoreName, Base[]>;
  for (const name of DATA_STORE_NAMES) {
    const p = plan[name] as StorePlan<Base>;
    const list: Base[] = [];
    if (choice.add) for (const r of p.add) list.push(r);
    if (choice.update) for (const r of p.update) list.push(r);
    out[name] = list;
  }
  return out as unknown as { [K in DataStoreName]: DataStoreRecords[K][] };
}
