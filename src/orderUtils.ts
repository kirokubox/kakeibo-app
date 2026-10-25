// 並び順（order）の入れ替え。画面の並べ替えモードの↑↓で使う

export interface Orderable {
  id: string;
  order: number;
}

/**
 * list（order の昇順に並べたもの）の中で id を上（up）か下（down）へ1つ動かし、order を 0 から振り直した新しい配列を返す。
 * isVisible を渡すと、見えていないもの（非表示）は飛ばして、見えている隣と入れ替える。
 * 動かせないとき（端・見つからない）は null。
 */
export function moveInOrder<T extends Orderable>(
  list: readonly T[],
  id: string,
  direction: "up" | "down",
  isVisible: (item: T) => boolean = () => true,
): T[] | null {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return null;
  const step = direction === "up" ? -1 : 1;
  let to = from + step;
  while (to >= 0 && to < list.length && !isVisible(list[to])) to += step;
  if (to < 0 || to >= list.length) return null;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next.map((x, i) => ({ ...x, order: i }));
}

/** order が変わったものだけを返す（保存する対象） */
export function changedOrders<T extends Orderable>(before: readonly T[], after: readonly T[]): T[] {
  const old = new Map(before.map((x) => [x.id, x.order]));
  return after.filter((x) => old.get(x.id) !== x.order);
}

/** order の昇順（同じなら id で安定させる） */
export function byOrder<T extends Orderable>(a: T, b: T): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
