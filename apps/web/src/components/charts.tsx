/**
 * Small charts drawn as SVG by the app (DECISIONS "Charts": no chart dependency). Each chart has a
 * table alternative for screen readers and keyboard users; colors come from the theme tokens, so
 * light and dark themes both work, and in right-to-left languages the time axis runs right to left.
 */
import { useId } from "react";
import { usePreferences } from "../app-context.tsx";

export interface ChartPoint {
  label: string;
  /** null: no data for this point (drawn as a gap, never as zero, T-193). */
  value: number | null;
  /** Second series (e.g. planned beside actual). */
  value2?: number | null;
}

interface ChartProps {
  points: ChartPoint[];
  title: string;
  /** Column headings of the table alternative. */
  columns: [string, string, string?];
  format?: (v: number) => string;
  compact?: boolean;
}

const W = 320;
const H = 120;
const PAD = 18;

function scaleOf(points: ChartPoint[]): number {
  return Math.max(1, ...points.flatMap((p) => [p.value ?? 0, p.value2 ?? 0]));
}

function TableAlternative({ points, title, columns, format }: ChartProps) {
  const f = format ?? String;
  return (
    <details className="chart-table">
      <summary>{title}</summary>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{columns[0]}</th>
            <th scope="col">{columns[1]}</th>
            {columns[2] ? <th scope="col">{columns[2]}</th> : null}
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}>
              <th scope="row">{p.label}</th>
              <td>{p.value === null ? "—" : f(p.value)}</td>
              {columns[2] ? <td>{p.value2 === null || p.value2 === undefined ? "—" : f(p.value2)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Bars (one or two series side by side). */
export function BarChart(props: ChartProps) {
  const { language } = usePreferences();
  const id = useId();
  const points = language === "fa" ? [...props.points].reverse() : props.points;
  const max = scaleOf(points);
  const two = points.some((p) => p.value2 !== undefined);
  const slot = (W - 2 * PAD) / Math.max(points.length, 1);
  const bar = Math.max(2, (two ? slot / 2 : slot) - 3);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  return (
    <figure className="chart" data-testid="bar-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className={props.compact ? "chart-svg chart-compact" : "chart-svg"}>
        <title id={`${id}-t`}>{props.title}</title>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="chart-axis" />
        {points.map((p, i) => {
          const x = PAD + i * slot;
          return (
            <g key={i}>
              {p.value !== null ? <rect x={x} y={y(p.value)} width={bar} height={H - PAD - y(p.value)} className="chart-bar" /> : null}
              {two && p.value2 !== null && p.value2 !== undefined ? <rect x={x + bar + 1} y={y(p.value2)} width={bar} height={H - PAD - y(p.value2)} className="chart-bar2" /> : null}
              {!props.compact && points.length <= 14 ? (
                <text x={x + (two ? bar : bar / 2)} y={H - 4} className="chart-label" textAnchor="middle">
                  {p.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <TableAlternative {...props} />
    </figure>
  );
}

/** A line over time; points without data are gaps, not zeros. */
export function LineChart(props: ChartProps) {
  const { language } = usePreferences();
  const id = useId();
  const points = language === "fa" ? [...props.points].reverse() : props.points;
  const max = scaleOf(points);
  const step = (W - 2 * PAD) / Math.max(points.length - 1, 1);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const runs: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length) runs.push(current.join(" "));
      current = [];
    } else current.push(`${PAD + i * step},${y(p.value)}`);
  });
  if (current.length) runs.push(current.join(" "));
  return (
    <figure className="chart" data-testid="line-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className={props.compact ? "chart-svg chart-compact" : "chart-svg"}>
        <title id={`${id}-t`}>{props.title}</title>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="chart-axis" />
        {runs.map((r, i) => (
          <polyline key={i} points={r} className="chart-line" />
        ))}
        {points.map((p, i) => (p.value !== null ? <circle key={i} cx={PAD + i * step} cy={y(p.value)} r={2.5} className="chart-dot" /> : null))}
      </svg>
      <TableAlternative {...props} />
    </figure>
  );
}
