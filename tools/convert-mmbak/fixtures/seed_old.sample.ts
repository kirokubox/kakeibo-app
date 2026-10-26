// テスト用の架空の「旧い初期分類」（本人の分類ではない）。make_profile.py のテストと、本人用の初期データの見本づくりに使う。
const D = "defaultDaily";
const M = "mustChoose";
const N = "none";

const EXPENSE = [
  { kind: "expense", name: "食費", children: [["テスト自炊", D], ["外食", M], ["テスト酒", M]] },
  { kind: "expense", name: "テスト生活", children: [["テスト日用品", D], ["病院・薬", N]] },
  {
    kind: "expense",
    name: "固定費",
    children: [["家賃", N], ["サブスク", N]],
  },
];

const INCOME = [
  { kind: "income", name: "給与", children: [["給与", N], ["手当", N], ["賞与", N]] },
  { kind: "income", name: "テスト副業", children: [["テスト副業A", N], ["テスト副業B", N]] },
  { kind: "income", name: "一時収入", children: [["立替返金", N], ["返金", N], ["その他", N]] },
];
