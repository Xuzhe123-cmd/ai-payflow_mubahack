/**
 * What the defense screen reads, from two endpoints.
 *
 * Split because they cost very different things: the snapshot is statistics and
 * one chain read, and renders at once; the analysis is two live model calls and
 * arrives seconds later. Keeping them apart is what lets the breaker's state —
 * the only fact that matters for security — appear immediately.
 */

import type { AnomalyAssessment } from "@/lib/defense/anomaly";
import type { Baseline, BehaviorStats } from "@/lib/defense/behaviorStats";
import type { ProviderHealth } from "@/lib/ai/providerHealth";
import type { CatalogEntry } from "@/lib/demo/invoiceCatalog";
import type { Consensus, ProviderResult } from "@/lib/ai/providers";
import type { BreakerConsequences, BreakerState } from "@/lib/sui/breakerReader";

export interface DefenseSnapshot {
  simulating: boolean;
  disclaimer: string | null;
  nowMs: number;
  /** Liveness per provider, from a real round trip. */
  health: ProviderHealth[];
  bothConnected: boolean;
  /** Every invoice the judge may select. Derived, never hard-coded. */
  catalog: CatalogEntry[];
  consensusCaveat: string;
  baseline: Baseline & { derived: boolean };
  stats: BehaviorStats;
  anomaly: AnomalyAssessment;
  /** Null when the chain could not be read. Never defaulted to "armed". */
  breaker: (BreakerState & { consequences: BreakerConsequences }) | null;
  breakerError: string | null;
}

/** The two independent opinions on one invoice, once the models answer. */
export interface DefenseAnalysis {
  mode: "LIVE" | "DEMO_FALLBACK";
  banner: string | null;
  disclaimer: string | null;
  recorded: boolean | null;
  liveFailures: { provider: string; status: string; reason: string | null }[];
  scenarioId: string | null;
  invoiceNumber: string;
  amountCents: number;
  supplierId: string | null;
  providers: ProviderResult[];
  consensus: Consensus;
  consensusCaveat: string;
  latencyMs: number;
}
