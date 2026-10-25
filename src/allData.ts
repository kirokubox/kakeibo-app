// 検索・集計のために全データを読む（開いたときと、保存・削除のあと＝version が変わったときに読み直す）。
// 約1万3千件を想定。起動時には読まず、検索・集計・書き出しを開いたときだけ読む。
import { useEffect, useRef, useState } from "react";
import { getAllData } from "./storage";
import type { DataSet } from "./types";

export interface AllDataState {
  data: DataSet | null;
  error: string;
}

export function useAllData(version: number): AllDataState {
  const [state, setState] = useState<AllDataState>({ data: null, error: "" });
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    getAllData()
      .then((data) => {
        if (my === seq.current) setState({ data, error: "" });
      })
      .catch((e) => {
        if (my === seq.current) setState((s) => ({ ...s, error: e instanceof Error ? e.message : "データを読み込めませんでした" }));
      });
  }, [version]);
  return state;
}
