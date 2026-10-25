// グラフ（SVGで手描き。ライブラリは使わない）。円グラフ・折れ線・棒（まとめて／積み上げ）＋線
import { formatYen } from "./money";

/** 軸の目盛り用：12,345 → 1.2万、1,234 → 1,234 */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 100_000_000) return `${sign}${trim(abs / 100_000_000)}億`;
  if (abs >= 10_000) return `${sign}${trim(abs / 10_000)}万`;
  return `${sign}${abs.toLocaleString("ja-JP")}`;
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

export interface LegendItem {
  label: string;
  color: string;
}

export function Legend({ items }: { items: readonly LegendItem[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className="legend-dot" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// ---- 円グラフ（ドーナツ） ----

export interface PieSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface PieProps {
  slices: readonly PieSlice[];
  /** 中央に出す文字（合計など） */
  center?: { top: string; bottom: string };
  onSelect?: (key: string) => void;
}

export function PieChart({ slices, center, onSelect }: PieProps) {
  const size = 200;
  const stroke = 38;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + x.value, 0);
  let offset = 0;
  return (
    <svg className="chart pie" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`円グラフ。${slices.map((s) => `${s.label} ${formatYen(s.value)}`).join("、")}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--kb-surface-2)" strokeWidth={stroke} />
      {total > 0 &&
        slices.map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${Math.max(len - (slices.length > 1 ? 1.5 : 0), 0)} ${c - len + (slices.length > 1 ? 1.5 : 0)}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className={onSelect ? "pie-slice clickable" : "pie-slice"}
              onClick={onSelect ? () => onSelect(s.key) : undefined}
            >
              <title>{`${s.label} ${formatYen(s.value)}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      {center && (
        <>
          <text x={size / 2} y={size / 2 - 4} textAnchor="middle" className="chart-center-top">
            {center.top}
          </text>
          <text x={size / 2} y={size / 2 + 16} textAnchor="middle" className="chart-center-bottom">
            {center.bottom}
          </text>
        </>
      )}
    </svg>
  );
}

// ---- 軸 ----

const W = 340;
const PAD = { left: 40, right: 8, top: 10, bottom: 22 };

interface Scale {
  min: number;
  max: number;
  y: (v: number) => number;
  ticks: number[];
}

function makeScale(values: readonly number[], height: number): Scale {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (max === min) max = min + 1;
  // 目盛りを切りのよい数に（最大を 1・2・5 の倍数に切り上げる）
  const span = max - min;
  const mag = Math.pow(10, Math.floor(Math.log10(span / 3)));
  const stepBase = span / 3 / mag;
  const step = (stepBase <= 1 ? 1 : stepBase <= 2 ? 2 : stepBase <= 5 ? 5 : 10) * mag;
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const plotH = height - PAD.top - PAD.bottom;
  return { min, max, y: (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH, ticks };
}

function Axes({ scale, height, labels, every }: { scale: Scale; height: number; labels: readonly string[]; every: number }) {
  const plotW = W - PAD.left - PAD.right;
  const slot = plotW / labels.length;
  return (
    <>
      {scale.ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={scale.y(t)} y2={scale.y(t)} className={t === 0 ? "axis-zero" : "axis-grid"} />
          <text x={PAD.left - 4} y={scale.y(t) + 3} textAnchor="end" className="axis-label">
            {formatCompact(t)}
          </text>
        </g>
      ))}
      {labels.map((l, i) =>
        i % every === 0 || i === labels.length - 1 ? (
          <text key={i} x={PAD.left + slot * (i + 0.5)} y={height - 6} textAnchor="middle" className="axis-label">
            {l}
          </text>
        ) : null,
      )}
    </>
  );
}

// ---- 折れ線 ----

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: ReadonlyArray<number | null>;
}

interface LineProps {
  labels: readonly string[];
  series: readonly LineSeries[];
  height?: number;
  ariaLabel: string;
}

export function LineChart({ labels, series, height = 170, ariaLabel }: LineProps) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const scale = makeScale(all, height);
  const plotW = W - PAD.left - PAD.right;
  const slot = plotW / labels.length;
  const x = (i: number) => PAD.left + slot * (i + 0.5);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
      <Axes scale={scale} height={height} labels={labels} every={2} />
      {series.map((s) => {
        let d = "";
        let pen = false;
        s.values.forEach((v, i) => {
          if (v === null) {
            pen = false;
            return;
          }
          d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${scale.y(v).toFixed(1)}`;
          pen = true;
        });
        return (
          <g key={s.key}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, i) =>
              v === null ? null : (
                <circle key={i} cx={x(i)} cy={scale.y(v)} r={2.5} fill={s.color}>
                  <title>{`${s.label} ${labels[i]} ${formatYen(v)}`}</title>
                </circle>
              ),
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---- 棒（まとめて／積み上げ）＋線 ----

export interface BarSeries {
  key: string;
  label: string;
  color: string;
  values: readonly number[];
}

interface BarProps {
  labels: readonly string[];
  series: readonly BarSeries[];
  stacked?: boolean;
  /** 棒に重ねる線（予算・差額など。null＝その月は無し） */
  line?: LineSeries;
  height?: number;
  ariaLabel: string;
}

export function BarChart({ labels, series, stacked = false, line, height = 170, ariaLabel }: BarProps) {
  const n = labels.length;
  const values: number[] = [];
  if (stacked) {
    for (let i = 0; i < n; i++) values.push(series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  } else {
    for (const s of series) values.push(...s.values);
  }
  if (line) values.push(...line.values.filter((v): v is number => v !== null));
  const scale = makeScale(values, height);
  const plotW = W - PAD.left - PAD.right;
  const slot = plotW / n;
  const inner = slot * 0.7;
  const barW = stacked ? inner : inner / series.length;
  const x0 = (i: number) => PAD.left + slot * i + (slot - inner) / 2;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
      <Axes scale={scale} height={height} labels={labels} every={2} />
      {labels.map((label, i) => {
        if (stacked) {
          let acc = 0;
          return (
            <g key={i}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                const y1 = scale.y(acc + v);
                const y0 = scale.y(acc);
                acc += v;
                if (v <= 0) return null;
                return (
                  <rect key={s.key} x={x0(i)} y={y1} width={barW} height={Math.max(y0 - y1, 0)} fill={s.color}>
                    <title>{`${label} ${s.label} ${formatYen(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        }
        return (
          <g key={i}>
            {series.map((s, k) => {
              const v = s.values[i] ?? 0;
              const yv = scale.y(v);
              const yz = scale.y(0);
              return (
                <rect key={s.key} x={x0(i) + barW * k} y={Math.min(yv, yz)} width={Math.max(barW - 1, 1)} height={Math.abs(yz - yv)} fill={s.color} rx={1}>
                  <title>{`${label} ${s.label} ${formatYen(v)}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
      {line && (
        <g>
          {(() => {
            let d = "";
            let pen = false;
            line.values.forEach((v, i) => {
              if (v === null) {
                pen = false;
                return;
              }
              d += `${pen ? "L" : "M"}${(PAD.left + slot * (i + 0.5)).toFixed(1)} ${scale.y(v).toFixed(1)}`;
              pen = true;
            });
            return <path d={d} fill="none" stroke={line.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
          })()}
          {line.values.map((v, i) =>
            v === null ? null : (
              <circle key={i} cx={PAD.left + slot * (i + 0.5)} cy={scale.y(v)} r={2.5} fill={line.color}>
                <title>{`${line.label} ${labels[i]} ${formatYen(v)}`}</title>
              </circle>
            ),
          )}
        </g>
      )}
    </svg>
  );
}
