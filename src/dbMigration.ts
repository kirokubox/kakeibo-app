// IndexedDB の版上げ（純粋な計画だけ。実際の作成は storage.ts）。
// 方針：既存のストアとデータには触れず、「無いものだけ足す」。版1→2 では subscriptionReviews が増える。
import { SETTINGS_STORE } from "./constants.js";
import { DATA_STORE_NAMES } from "./types.js";
import type { DataStoreName } from "./types.js";

export interface UpgradePlan {
  /** 新しく作るデータストア */
  create: DataStoreName[];
  /** 設定のストアを作るか */
  createSettings: boolean;
}

/** いまあるストア名から、足りないものだけを数える（空のDBなら全部、版1のDBなら新しい版で増えたものだけ） */
export function planUpgrade(existing: readonly string[]): UpgradePlan {
  return {
    create: DATA_STORE_NAMES.filter((n) => !existing.includes(n)),
    createSettings: !existing.includes(SETTINGS_STORE),
  };
}
