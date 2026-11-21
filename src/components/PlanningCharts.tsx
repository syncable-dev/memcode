import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChartNoAxesCombined,
} from "lucide-react";
import type { Cycle } from "../shared";
import { cycleSeries } from "../planning/analytics";
import { dateLabel, dayAt } from "../planning/dates";

export type PlanningUnit = "issues" | "points";
type Datum = { date: string; [key: string]: string | number | null };
type Series = { key: string; name: string; color: string; dashed?: boolean };
function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(640);
  useEffect(() => {
    const measure = () => {
      const next = ref.current?.getBoundingClientRect().width;
      if (next) setWidth(Math.max(280, next));
    };
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    measure();
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
export const countLabel = (value: number) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);

export function UnitToggle({
  unit,
  setUnit,
}: {
  unit: PlanningUnit;
  setUnit: (unit: PlanningUnit) => void;
}) {
  return (
    <div className="planning-unit-toggle" aria-label="Chart measurement">
      <button
        className={unit === "issues" ? "active" : ""}
        aria-pressed={unit === "issues"}
        onClick={() => setUnit("issues")}
      >
        Tasks
      </button>
      <button
        className={unit === "points" ? "active" : ""}
        aria-pressed={unit === "points"}
        onClick={() => setUnit("points")}
      >
        Points
      </button>
    </div>
  );
}

function segmentPath(
  data: Datum[],
  key: string,
  x: (index: number) => number,
  y: (value: number) => number,
) {
  let open = false;
  return data
    .map((row, index) => {
      const value = row[key];
      if (typeof value !== "number") {
        open = false;
        return "";
      }
      const command = open ? "L" : "M";
      open = true;
      return `${command}${x(index).toFixed(2)},${y(value).toFixed(2)}`;
    })
    .join(" ");
}

export function LineChart({
  title,
  description,
  data,
  series,
  unit,
  today,
}: {
  title: string;
  description: string;
  data: Datum[];
  series: Series[];
  unit: string;
  today?: string;
}) {
  const id = useId(),
    [selected, setSelected] = useState<number | null>(null);
  const { ref, width } = useChartWidth();
  const height = 222,
    left = 42,
    right = 15,
    top = 21,
    bottom = 34,
    plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const maximum = Math.max(
    1,
    ...data.flatMap((row) =>
      series.map((item) =>
        typeof row[item.key] === "number" ? (row[item.key] as number) : 0,
      ),
    ),
  );
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
  const step = Math.max(
    1,
    [1, 2, 5, 10]
      .map((value) => value * magnitude)
      .find((value) => value >= maximum / 4) ?? 1,
  );
  const ceiling = Math.ceil(maximum / step) * step;
  const x = (index: number) =>
    left + (data.length > 1 ? index / (data.length - 1) : 0.5) * plotWidth;
  const y = (value: number) =>
    top + plotHeight - (value / ceiling) * plotHeight;
  const indices = [
    ...new Set([0, Math.floor((data.length - 1) / 2), data.length - 1]),
  ].filter((index) => index >= 0);
  const todayIndex = today ? data.findIndex((row) => row.date === today) : -1;
  const point = selected === null ? null : data[selected];
  const inspect = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    setSelected(
      Math.max(
        0,
        Math.min(
          data.length - 1,
          Math.round(((svgX - left) / plotWidth) * (data.length - 1)),
        ),
      ),
    );
  };
  return (
    <div className="planning-plot">
      <div className="planning-chart-legend">
        {series.map((item) => (
          <span
            key={item.key}
            style={{ "--series-color": item.color } as CSSProperties}
          >
            <i className={item.dashed ? "dashed" : ""} />
            {item.name}
          </span>
        ))}
      </div>
      <div className="planning-plot-canvas" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
          tabIndex={data.length ? 0 : undefined}
          onPointerMove={inspect}
          onPointerLeave={() => setSelected(null)}
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
              !data.length
            )
              return;
            event.preventDefault();
            setSelected((current) =>
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? data.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        data.length - 1,
                        (current ?? data.length - 1) +
                          (event.key === "ArrowLeft" ? -1 : 1),
                      ),
                    ),
            );
          }}
          onBlur={() => setSelected(null)}
        >
          <title id={`${id}-title`}>{title}</title>
          <desc id={`${id}-description`}>
            {description} Values are {unit}. Gaps indicate unrecorded days. Use
            left and right arrow keys to inspect daily values, or open the data
            table below.
          </desc>
          {Array.from(
            { length: Math.round(ceiling / step) + 1 },
            (_, index) => index * step,
          ).map((value) => (
            <g key={value}>
              <line
                x1={left}
                y1={y(value)}
                x2={width - right}
                y2={y(value)}
                className="planning-chart-grid"
              />
              <text
                x={left - 10}
                y={y(value) + 3}
                textAnchor="end"
                className="planning-chart-axis"
              >
                {countLabel(value)}
              </text>
            </g>
          ))}
          {indices.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 9}
              textAnchor={
                index === 0
                  ? "start"
                  : index === data.length - 1
                    ? "end"
                    : "middle"
              }
              className="planning-chart-axis"
            >
              {dateLabel(data[index].date)}
            </text>
          ))}
          {todayIndex >= 0 && (
            <g>
              <line
                x1={x(todayIndex)}
                y1={top}
                x2={x(todayIndex)}
                y2={top + plotHeight}
                className="planning-chart-today"
              />
              <text
                x={Math.max(
                  left + 18,
                  Math.min(width - right - 18, x(todayIndex)),
                )}
                y={11}
                textAnchor="middle"
                className="planning-chart-today-label"
              >
                Today
              </text>
            </g>
          )}
          {series.map((item) => {
            const valid = data
              .map((row, index) => ({ value: row[item.key], index }))
              .filter((row) => typeof row.value === "number");
            const lone = valid.length === 1 ? valid[0] : null;
            return (
              <g key={item.key}>
                <path
                  d={segmentPath(data, item.key, x, y)}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={item.dashed ? 1.5 : 2.4}
                  strokeDasharray={item.dashed ? "5 5" : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {lone && (
                  <circle
                    cx={x(lone.index)}
                    cy={y(lone.value as number)}
                    r={item.dashed ? 2.5 : 4}
                    fill={item.color}
                  />
                )}
              </g>
            );
          })}
          {point && selected !== null && (
            <g>
              <line
                x1={x(selected)}
                x2={x(selected)}
                y1={top}
                y2={top + plotHeight}
                className="planning-chart-inspect"
              />
              {series.map(
                (item) =>
                  typeof point[item.key] === "number" && (
                    <circle
                      key={item.key}
                      cx={x(selected)}
                      cy={y(point[item.key] as number)}
                      r={4}
                      fill="white"
                      stroke={item.color}
                      strokeWidth={2}
                    />
                  ),
              )}
            </g>
          )}
        </svg>
        {point && selected !== null && (
          <div
            className="planning-chart-tooltip"
            style={{
              left: `clamp(12px, ${(selected / Math.max(1, data.length - 1)) * 100}%, calc(100% - 185px))`,
            }}
          >
            <strong>
              {dateLabel(point.date, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </strong>
            {series.map((item) => (
              <span key={item.key}>
                <i style={{ background: item.color }} />
                {item.name}
                <b>
                  {typeof point[item.key] === "number"
                    ? countLabel(point[item.key] as number)
                    : "Unrecorded"}
                </b>
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="planning-chart-sr" aria-live="polite">
        {point
          ? `${dateLabel(point.date)}. ${series.map((item) => `${item.name}: ${typeof point[item.key] === "number" ? countLabel(point[item.key] as number) : "unrecorded"}`).join(". ")}`
          : ""}
      </p>
      <details className="planning-data-table">
        <summary>
          View daily data<span>{unit} · arrow keys inspect the chart</span>
        </summary>
        <div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                {series.map((item) => (
                  <th key={item.key}>{item.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.date}>
                  <th>
                    {dateLabel(row.date, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </th>
                  {series.map((item) => (
                    <td key={item.key}>
                      {typeof row[item.key] === "number"
                        ? countLabel(row[item.key] as number)
                        : "Unrecorded"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export function CycleCharts({
  cycle,
  unit,
}: {
  cycle: Cycle;
  unit: PlanningUnit;
}) {
  const points = cycleSeries(cycle, unit),
    today = dayAt(undefined, cycle.timeZone);
  const baseline = cycle.baseline
    ? unit === "points"
      ? cycle.baseline.points
      : cycle.baseline.total
    : null;
  const burnup: Datum[] = points.map((point) => ({
    ...point,
    idealCompleted:
      baseline !== null && point.ideal !== null ? baseline - point.ideal : null,
  }));
  const first = cycle.snapshots[0]
    ? dayAt(cycle.snapshots[0].at, cycle.timeZone)
    : null;
  const label =
    unit === "issues" ? "tasks" : "manually estimated points";
  const note = !first
    ? "Progress appears when the first snapshot is recorded."
    : `History begins ${dateLabel(first)}. Earlier days and future actuals are unrecorded.`;
  return (
    <div className="cycle-charts">
      <section className="planning-chart-card">
        <header>
          <span className="planning-chart-icon mint">
            <ArrowDownRight size={17} />
          </span>
          <div>
            <h3>Burndown</h3>
            <p>Remaining work against the ideal plan.</p>
          </div>
        </header>
        <LineChart
          title={`${cycle.name} burndown`}
          description="Recorded remaining scope and the ideal remaining-work plan."
          data={points as unknown as Datum[]}
          series={[
            { key: "remaining", name: "Recorded remaining", color: "#1b9d7e" },
            {
              key: "ideal",
              name: "Ideal plan",
              color: "#a5b6a6",
              dashed: true,
            },
          ]}
          unit={label}
          today={today}
        />
        <p className="planning-chart-note">
          {note}
          {!cycle.baseline &&
            " Start the cycle to capture its planning baseline."}
        </p>
      </section>
      <section className="planning-chart-card">
        <header>
          <span className="planning-chart-icon cyan">
            <ArrowUpRight size={17} />
          </span>
          <div>
            <h3>Burnup</h3>
            <p>Completed work and the changing scope.</p>
          </div>
        </header>
        <LineChart
          title={`${cycle.name} burnup`}
          description="Recorded completed work and scope, with an ideal completion plan based on the starting baseline."
          data={burnup}
          series={[
            { key: "completed", name: "Recorded done", color: "#329eb1" },
            { key: "scope", name: "Recorded scope", color: "#8b9c8b" },
            {
              key: "idealCompleted",
              name: "Ideal plan",
              color: "#b5c3b0",
              dashed: true,
            },
          ]}
          unit={label}
          today={today}
        />
        <p className="planning-chart-note">
          {unit === "points"
            ? "Unestimated tasks are excluded from point totals. Points are planning estimates."
            : "Scope changes remain visible. A worker exit does not count as accepted completion."}
        </p>
      </section>
    </div>
  );
}

export function ThroughputChart({
  data,
  unit,
}: {
  data: Array<{ date: string; issues: number | null; points: number | null }>;
  unit: PlanningUnit;
}) {
  const id = useId(),
    [selected, setSelected] = useState<number | null>(null);
  const { ref, width } = useChartWidth();
  const height = 222,
    left = 36,
    right = 14,
    top = 20,
    bottom = 34,
    plotHeight = height - top - bottom;
  const values = data.map((point) => point[unit]),
    maximum = Math.max(
      1,
      ...values.filter((value): value is number => value !== null),
    ),
    step = (width - left - right) / Math.max(1, data.length),
    bar = Math.max(2, step * 0.55);
  const current = selected === null ? null : data[selected];
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    observed = values.filter((value) => value !== null).length;
  return (
    <div className="planning-plot">
      <div className="planning-chart-legend">
        <span style={{ "--series-color": "#24ab8c" } as CSSProperties}>
          <i />
          {unit === "issues"
            ? "Recorded Done transitions"
            : "Points at each Done transition"}
        </span>
        <span className="planning-chart-observations">
          {observed} observed {observed === 1 ? "day" : "days"}
        </span>
      </div>
      <div className="planning-plot-canvas" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
          tabIndex={0}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const position = ((event.clientX - rect.left) / rect.width) * width;
            setSelected(
              Math.max(
                0,
                Math.min(data.length - 1, Math.floor((position - left) / step)),
              ),
            );
          }}
          onPointerLeave={() => setSelected(null)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            setSelected((index) =>
              Math.max(
                0,
                Math.min(
                  data.length - 1,
                  (index ?? data.length - 1) +
                    (event.key === "ArrowLeft" ? -1 : 1),
                ),
              ),
            );
          }}
          onBlur={() => setSelected(null)}
        >
          <title id={`${id}-title`}>Recorded delivery throughput</title>
          <desc id={`${id}-description`}>
            Daily transitions into Done. Previously completed baseline work is
            excluded. Dates before tracking began are unrecorded, not zero. Use
            arrow keys to inspect daily values.
          </desc>
          {[0, 0.5, 1].map((ratio) => (
            <g key={ratio}>
              <line
                x1={left}
                x2={width - right}
                y1={top + plotHeight * (1 - ratio)}
                y2={top + plotHeight * (1 - ratio)}
                className="planning-chart-grid"
              />
              <text
                x={left - 10}
                y={top + plotHeight * (1 - ratio) + 3}
                textAnchor="end"
                className="planning-chart-axis"
              >
                {countLabel(maximum * ratio)}
              </text>
            </g>
          ))}
          {data.map((point, index) =>
            point[unit] === null ? (
              <line
                key={point.date}
                x1={left + step * (index + 0.5)}
                x2={left + step * (index + 0.5)}
                y1={height - bottom - 3}
                y2={height - bottom}
                stroke="#d4ded2"
              />
            ) : (
              <rect
                key={point.date}
                x={left + step * (index + 0.5) - bar / 2}
                y={
                  height - bottom - ((point[unit] ?? 0) / maximum) * plotHeight
                }
                width={bar}
                height={((point[unit] ?? 0) / maximum) * plotHeight}
                rx={3}
                fill={index === selected ? "#168b71" : "#51bfa0"}
              />
            ),
          )}
          {[0, Math.floor((data.length - 1) / 2), data.length - 1].map(
            (index) => (
              <text
                key={index}
                x={left + step * (index + 0.5)}
                y={height - 9}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === data.length - 1
                      ? "end"
                      : "middle"
                }
                className="planning-chart-axis"
              >
                {dateLabel(data[index].date)}
              </text>
            ),
          )}
        </svg>
        {total === 0 && (
          <div className="throughput-no-events">
            <ChartNoAxesCombined size={24} />
            <strong>No completion transitions yet.</strong>
            <span>New accepted work will appear here as it happens.</span>
          </div>
        )}
        {current && selected !== null && (
          <div
            className="planning-chart-tooltip"
            style={{
              left: `clamp(12px, ${(selected / Math.max(1, data.length - 1)) * 100}%, calc(100% - 185px))`,
            }}
          >
            <strong>{dateLabel(current.date)}</strong>
            <span>
              {unit === "issues" ? "Done transitions" : "Estimated points"}
              <b>
                {current[unit] === null
                  ? "Unrecorded"
                  : countLabel(current[unit]!)}
              </b>
            </span>
          </div>
        )}
      </div>
      <p className="planning-chart-sr" aria-live="polite">
        {current
          ? `${dateLabel(current.date)}: ${current[unit] === null ? "unrecorded" : countLabel(current[unit]!)} ${unit === "issues" ? "Done transitions" : "estimated points"}`
          : ""}
      </p>
      <details className="planning-data-table">
        <summary>
          View daily data<span>Baseline completions excluded</span>
        </summary>
        <div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Done transitions</th>
                <th>Estimated points</th>
              </tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.date}>
                  <th>
                    {dateLabel(point.date, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </th>
                  <td>{point.issues ?? "Unrecorded"}</td>
                  <td>{point.points ?? "Unrecorded"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
