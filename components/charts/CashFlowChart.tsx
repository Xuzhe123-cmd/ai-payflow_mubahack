"use client";

/**
 * Cash-flow forecast chart.
 *
 * Draws series that the deterministic layer produced. It does no financial
 * maths of its own — every balance, trough and breach flag arrives in the
 * CashProjection, so the picture can never disagree with the recommendation.
 *
 * The reserve line is the point of the whole component: it is drawn as a hard
 * floor, and any part of a projection that falls beneath it is filled red, so
 * "breach" is legible before a single label is read.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { CashProjection, ProjectionSeries } from "@/lib/deterministic/projection";
import type { CashFlowEvent, IsoDate } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatCompactMoney, formatDay, formatMoneyRounded } from "@/lib/format";

interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const PADDING: Padding = { top: 18, right: 78, bottom: 26, left: 8 };

export interface CashFlowChartProps {
  projection: CashProjection;
  /** Candidate series to draw in full. Falls back to the baseline. */
  activeSeriesId?: string | null;
  /** Optional second series, drawn faintly for comparison. */
  compareSeriesId?: string | null;
  height?: number;
  showEvents?: boolean;
  className?: string;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth(next);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/**
 * Round tick values over the data's own range.
 *
 * Anchoring the axis at zero would flatten every treasury chart into a line
 * near the top, hiding exactly the movement the operator needs to see. The
 * reserve is what gives the scale meaning, so it is always inside the range.
 */
function niceScale(min: number, max: number, count = 4) {
  const span = Math.max(max - min, 1);
  const rawStep = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) *
    magnitude;

  // The bounds stay on the data. Rounding them out to the step instead would
  // regularly double the range and squash the curve into a flat line.
  const ticks: number[] = [];
  for (
    let value = Math.ceil(min / step) * step;
    value <= max + step / 1000;
    value += step
  ) {
    ticks.push(Math.round(value));
  }
  return { min, max, ticks };
}

function seriesOrBaseline(
  projection: CashProjection,
  id: string | null | undefined,
): ProjectionSeries {
  if (!id) return projection.baseline;
  return projection.candidates.find((series) => series.id === id) ?? projection.baseline;
}

export function CashFlowChart({
  projection,
  activeSeriesId,
  compareSeriesId,
  height = 260,
  showEvents = true,
  className,
}: CashFlowChartProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  // Two charts can share a page with different reserve lines, so the SVG ids
  // have to be per-instance or the second one clips against the first.
  const uid = useId().replace(/:/g, "");
  const areaFillId = `payflow-area-${uid}`;
  const breachClipId = `payflow-breach-${uid}`;

  const active = seriesOrBaseline(projection, activeSeriesId);
  const compare = compareSeriesId
    ? seriesOrBaseline(projection, compareSeriesId)
    : null;

  const geometry = useMemo(() => {
    const points = active.points;
    const innerWidth = Math.max(0, width - PADDING.left - PADDING.right);
    const innerHeight = Math.max(0, height - PADDING.top - PADDING.bottom);

    const values = [
      ...points.map((point) => point.balanceCents),
      ...(compare?.points.map((point) => point.balanceCents) ?? []),
      projection.minimumReserveCents,
    ];
    const rawMax = Math.max(...values);
    const rawMin = Math.min(...values);
    const pad = Math.max(rawMax - rawMin, 1) * 0.1;
    const { min, max, ticks } = niceScale(rawMin - pad, rawMax + pad);

    const x = (index: number) =>
      PADDING.left +
      (points.length <= 1 ? 0 : (index / (points.length - 1)) * innerWidth);
    const y = (cents: number) =>
      PADDING.top + innerHeight - ((cents - min) / Math.max(max - min, 1)) * innerHeight;

    return { points, innerWidth, innerHeight, min, max, ticks, x, y };
  }, [active, compare, height, projection.minimumReserveCents, width]);

  const { points, innerHeight, x, y } = geometry;

  const linePath = useMemo(
    () => points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(point.balanceCents).toFixed(2)}`).join(" "),
    [points, x, y],
  );

  const areaPath = useMemo(() => {
    if (points.length === 0) return "";
    const base = PADDING.top + innerHeight;
    return `${linePath} L${x(points.length - 1).toFixed(2)},${base} L${x(0).toFixed(2)},${base} Z`;
  }, [innerHeight, linePath, points.length, x]);

  /**
   * The region between the curve and the reserve line. Clipped to below the
   * reserve, it leaves exactly the breach — shading the whole width below the
   * line would claim a breach on days that never had one.
   */
  const breachPath = useMemo(() => {
    if (points.length === 0) return "";
    const reserve = y(projection.minimumReserveCents).toFixed(2);
    return `${linePath} L${x(points.length - 1).toFixed(2)},${reserve} L${x(0).toFixed(2)},${reserve} Z`;
  }, [linePath, points.length, projection.minimumReserveCents, x, y]);

  const comparePath = useMemo(() => {
    if (!compare) return null;
    return compare.points
      .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(point.balanceCents).toFixed(2)}`)
      .join(" ");
  }, [compare, x, y]);

  const reserveY = y(projection.minimumReserveCents);

  const xTickEvery = points.length > 24 ? 5 : points.length > 12 ? 3 : 2;

  const eventsByDate = useMemo(() => {
    const map = new Map<IsoDate, CashFlowEvent[]>();
    for (const event of projection.events) {
      map.set(event.date, [...(map.get(event.date) ?? []), event]);
    }
    return map;
  }, [projection.events]);

  const paymentIndex = active.paymentDate
    ? points.findIndex((point) => point.date === active.paymentDate)
    : -1;

  const hoverPoint = hover !== null ? points[hover] : null;
  const currency = projection.currency;

  return (
    <div ref={wrapRef} className={cn("relative w-full select-none", className)}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          className="block overflow-visible"
          role="img"
          aria-label="Projected treasury balance"
        >
          <defs>
            <linearGradient id={areaFillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ai)" stopOpacity="0.20" />
              <stop offset="100%" stopColor="var(--ai)" stopOpacity="0.01" />
            </linearGradient>
            <clipPath id={breachClipId}>
              <rect
                x={0}
                y={reserveY}
                width={width}
                height={Math.max(0, PADDING.top + innerHeight - reserveY)}
              />
            </clipPath>
          </defs>

          {/* horizontal rules */}
          {geometry.ticks.map((value) => (
            <g key={value}>
              <line
                x1={PADDING.left}
                x2={width - PADDING.right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--hairline)"
                strokeWidth={1}
              />
              <text
                x={width - PADDING.right + 8}
                y={y(value) + 3.5}
                className="tabular fill-[var(--ink-faint)] text-[10.5px]"
              >
                {formatCompactMoney(value, currency)}
              </text>
            </g>
          ))}

          {/* area + breach fill */}
          <path d={areaPath} fill={`url(#${areaFillId})`} />
          <g clipPath={`url(#${breachClipId})`}>
            <path d={breachPath} fill="var(--neg)" fillOpacity="0.28" />
          </g>

          {/* minimum reserve floor */}
          <line
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={reserveY}
            y2={reserveY}
            stroke="var(--neg)"
            strokeWidth={1.25}
            strokeDasharray="5 4"
            opacity={0.85}
          />
          <text
            x={width - PADDING.right - 4}
            y={reserveY - 6}
            textAnchor="end"
            stroke="var(--surface)"
            strokeWidth={3.5}
            paintOrder="stroke"
            className="fill-[var(--neg)] text-[9.5px] font-semibold tracking-wide"
          >
            MINIMUM RESERVE
          </text>

          {/* comparison series */}
          {comparePath ? (
            <path
              d={comparePath}
              fill="none"
              stroke="var(--ink-faint)"
              strokeWidth={1.25}
              strokeDasharray="3 3"
              opacity={0.65}
            />
          ) : null}

          {/* main series */}
          <path
            d={linePath}
            fill="none"
            stroke="var(--ai)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Any stretch of the projection under the floor is drawn in red, so a
              breach is visible even when the band between them is thin. */}
          <g clipPath={`url(#${breachClipId})`}>
            <path
              d={linePath}
              fill="none"
              stroke="var(--neg)"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>

          {/* payment marker */}
          {paymentIndex >= 0 ? (
            <g>
              <line
                x1={x(paymentIndex)}
                x2={x(paymentIndex)}
                y1={PADDING.top - 6}
                y2={PADDING.top + innerHeight}
                stroke="var(--ai)"
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.5}
              />
              <circle
                cx={x(paymentIndex)}
                cy={y(points[paymentIndex].balanceCents)}
                r={4.5}
                fill="var(--surface)"
                stroke="var(--ai)"
                strokeWidth={2}
              />
            </g>
          ) : null}

          {/* trough marker */}
          {(() => {
            const troughIndex = points.findIndex(
              (point) => point.date === active.minimumCashDate,
            );
            if (troughIndex < 0) return null;
            return (
              <circle
                cx={x(troughIndex)}
                cy={y(points[troughIndex].balanceCents)}
                r={3}
                fill={active.reserveBreach ? "var(--neg)" : "var(--pos)"}
              />
            );
          })()}

          {/* cash-flow events */}
          {showEvents
            ? points.map((point, index) => {
                const events = eventsByDate.get(point.date);
                if (!events || events.length === 0) return null;
                const inflow = events.some((event) => event.direction === "INFLOW");
                const outflow = events.some((event) => event.direction === "OUTFLOW");
                const color = inflow && !outflow ? "var(--pos)" : outflow && !inflow ? "var(--warn)" : "var(--chain)";
                return (
                  <rect
                    key={point.date}
                    x={x(index) - 1}
                    y={PADDING.top + innerHeight + 3}
                    width={2}
                    height={5}
                    rx={1}
                    fill={color}
                  />
                );
              })
            : null}

          {/* x axis labels */}
          {points.map((point, index) =>
            index % xTickEvery === 0 || index === points.length - 1 ? (
              <text
                key={point.date}
                x={x(index)}
                y={height - 6}
                textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
                className="fill-[var(--ink-faint)] text-[10.5px]"
              >
                {formatDay(point.date)}
              </text>
            ) : null,
          )}

          {/* hover target + crosshair */}
          {hover !== null && hoverPoint ? (
            <g pointerEvents="none">
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PADDING.top - 6}
                y2={PADDING.top + innerHeight}
                stroke="var(--ink-faint)"
                strokeWidth={1}
                opacity={0.4}
              />
              <circle
                cx={x(hover)}
                cy={y(hoverPoint.balanceCents)}
                r={3.5}
                fill="var(--ai)"
              />
            </g>
          ) : null}

          <rect
            x={PADDING.left}
            y={PADDING.top - 10}
            width={Math.max(0, width - PADDING.left - PADDING.right)}
            height={innerHeight + 14}
            fill="transparent"
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
              const index = Math.round(ratio * (points.length - 1));
              setHover(Math.max(0, Math.min(points.length - 1, index)));
            }}
          />
        </svg>
      ) : (
        <div style={{ height }} />
      )}

      {hover !== null && hoverPoint && width > 0 ? (
        <div
          className={cn(
            "pointer-events-none absolute z-10 min-w-[152px] rounded-lg border border-hairline",
            "bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-sm",
          )}
          style={{
            left: Math.min(Math.max(x(hover) - 76, 0), Math.max(width - 168, 0)),
            top: 4,
          }}
        >
          <div className="text-[11px] font-medium text-ink-faint">
            {formatDay(hoverPoint.date)}
          </div>
          <div className="tabular mt-0.5 text-[15px] font-semibold text-ink">
            {formatMoneyRounded(hoverPoint.balanceCents, currency)}
          </div>
          {(eventsByDate.get(hoverPoint.date) ?? []).map((event) => (
            <div
              key={event.id}
              className="mt-1 flex items-baseline justify-between gap-3 text-[11.5px]"
            >
              <span className="truncate text-ink-faint">{event.description}</span>
              <span
                className={cn(
                  "tabular shrink-0 font-medium",
                  event.direction === "INFLOW" ? "text-pos" : "text-warn",
                )}
              >
                {event.direction === "INFLOW" ? "+" : "−"}
                {formatCompactMoney(event.amountCents, currency)}
              </span>
            </div>
          ))}
          {hoverPoint.paymentCents > 0 ? (
            <div className="mt-1 flex items-baseline justify-between gap-3 text-[11.5px]">
              <span className="text-ai">Invoice payment</span>
              <span className="tabular shrink-0 font-medium text-ai">
                −{formatCompactMoney(hoverPoint.paymentCents, currency)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Compact legend, shared by the dashboard and treasury cards. */
export function ChartLegend({
  reserveCents,
  currency,
  activeLabel,
  compareLabel,
  className,
}: {
  reserveCents: number;
  currency: string;
  activeLabel: string;
  compareLabel?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-5 gap-y-2", className)}>
      <span className="flex items-center gap-2 text-[12px] text-ink-soft">
        <span className="h-0.5 w-5 rounded-full bg-ai" />
        {activeLabel}
      </span>
      {compareLabel ? (
        <span className="flex items-center gap-2 text-[12px] text-ink-soft">
          <span className="h-0.5 w-5 rounded-full bg-ink-faint/60 [background-image:repeating-linear-gradient(90deg,currentColor_0_3px,transparent_3px_6px)]" />
          {compareLabel}
        </span>
      ) : null}
      <span className="flex items-center gap-2 text-[12px] text-ink-soft">
        <span className="h-0 w-5 border-t-[1.5px] border-dashed border-neg" />
        Minimum reserve {formatMoneyRounded(reserveCents, currency)}
      </span>
    </div>
  );
}
