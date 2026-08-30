/**
 * The cash position, readable in about five seconds.
 *
 * One line for the projected balance, one flat line for the minimum reserve,
 * and bars for the inflows and outflows that move it. Anything below the
 * reserve is shaded red, because "are we about to go under the line" is the
 * only question this chart needs to answer at a glance.
 *
 * It computes nothing. Every coordinate comes from a Timeline built by
 * lib/decision/present.ts, which in turn uses the same forecastCash the
 * decision engine uses — so the chart and the recommendation cannot disagree.
 */

import type { Timeline } from "@/lib/decision/present";
import { formatMoneyRounded } from "@/lib/util/money";

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 68 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

export function CashFlowTimeline({ timeline }: { timeline: Timeline }) {
  const { points, reserveCents, minCents, maxCents } = timeline;
  if (points.length === 0) return null;

  const span = Math.max(1, maxCents - minCents);
  const x = (index: number) => PAD.left + (index / Math.max(1, points.length - 1)) * PLOT_W;
  const y = (cents: number) => PAD.top + PLOT_H - ((cents - minCents) / span) * PLOT_H;

  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.balanceCents)}`).join(" ");
  const area = `${line} L${x(points.length - 1)},${y(minCents)} L${x(0)},${y(minCents)} Z`;
  const reserveY = y(reserveCents);

  // Roughly five labels, whatever the horizon length.
  const tickEvery = Math.max(1, Math.ceil(points.length / 5));

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`Projected treasury balance against a ${formatMoneyRounded(reserveCents)} minimum reserve`}
      >
        <defs>
          <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chain)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-chain)" stopOpacity="0.02" />
          </linearGradient>
          {/* Everything below the reserve line is shaded, so a dip is visible
              without reading a single number. */}
          <clipPath id="belowReserve">
            <rect x={PAD.left} y={reserveY} width={PLOT_W} height={Math.max(0, PAD.top + PLOT_H - reserveY)} />
          </clipPath>
        </defs>

        <rect
          x={PAD.left}
          y={reserveY}
          width={PLOT_W}
          height={Math.max(0, PAD.top + PLOT_H - reserveY)}
          fill="var(--color-neg)"
          opacity="0.05"
        />

        <path d={area} fill="url(#balanceFill)" />
        <path d={area} fill="var(--color-neg)" opacity="0.16" clipPath="url(#belowReserve)" />

        {/* Inflow and outflow bars, drawn from the baseline. */}
        {points.map((point, index) =>
          point.inflowCents === 0 && point.outflowCents === 0 ? null : (
            <g key={point.date}>
              {point.inflowCents > 0 && (
                <rect x={x(index) - 3} y={PAD.top + PLOT_H - 10} width={6} height={10} rx={1} fill="var(--color-pos)" opacity="0.65" />
              )}
              {point.outflowCents > 0 && (
                <rect x={x(index) - 3} y={PAD.top + PLOT_H - 10} width={6} height={10} rx={1} fill="var(--color-warn)" opacity="0.75" />
              )}
            </g>
          ),
        )}

        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={reserveY}
          y2={reserveY}
          stroke="var(--color-neg)"
          strokeWidth="1.5"
          strokeDasharray="5 4"
        />
        <text x={PAD.left - 8} y={reserveY + 4} textAnchor="end" className="fill-[var(--color-neg)] text-[10px]">
          {formatMoneyRounded(reserveCents)}
        </text>

        <path d={line} fill="none" stroke="var(--color-chain)" strokeWidth="2.25" strokeLinejoin="round" />

        {timeline.paymentDate && (
          <>
            {points.map((point, index) =>
              point.isPaymentDate ? (
                <g key={`pay-${point.date}`}>
                  <line x1={x(index)} x2={x(index)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="var(--color-ai)" strokeWidth="1.25" strokeDasharray="3 3" />
                  <circle cx={x(index)} cy={y(point.balanceCents)} r="4.5" fill="var(--color-ai)" />
                </g>
              ) : null,
            )}
          </>
        )}

        {points.map((point, index) =>
          index % tickEvery === 0 || index === points.length - 1 ? (
            <text key={`t-${point.date}`} x={x(index)} y={HEIGHT - 8} textAnchor="middle" className="fill-[var(--color-ink-faint)] text-[10px]">
              {point.date.slice(5)}
            </text>
          ) : null,
        )}

        <text x={PAD.left - 8} y={y(maxCents) + 10} textAnchor="end" className="fill-[var(--color-ink-faint)] text-[10px]">
          {formatMoneyRounded(maxCents)}
        </text>
      </svg>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
        <Swatch color="var(--color-chain)">Projected balance</Swatch>
        <Swatch color="var(--color-neg)">Minimum reserve</Swatch>
        <Swatch color="var(--color-pos)">Inflow</Swatch>
        <Swatch color="var(--color-warn)">Outflow</Swatch>
        {timeline.paymentDate && <Swatch color="var(--color-ai)">Recommended payment</Swatch>}
      </figcaption>

      {timeline.balanceAfterPaymentCents !== null && (
        <p className="mt-2 text-xs text-ink-faint">
          Balance the chain will check on {timeline.paymentDate}:{" "}
          <strong className="text-ink-soft">{formatMoneyRounded(timeline.balanceAfterPaymentCents)}</strong>. The line
          above is end-of-day; the chain checks the vault at the moment of payment and does not count money
          arriving later that same day.
        </p>
      )}
    </figure>
  );
}

function Swatch({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}
