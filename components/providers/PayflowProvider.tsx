"use client";

/**
 * The demo state machine.
 *
 *   SIGNED_OUT -> INBOX_DISCONNECTED -> CONNECTING -> READY
 *
 * and per invoice:
 *
 *   DETECTED -> ANALYZING -> ANALYZED -> (EXECUTING -> PAID)
 *
 * Every scenario drives the SAME transitions and the SAME components. Nothing
 * here branches on which scenario is loaded — the eight demo cases differ only
 * in the data they carry, which is the whole point of the architecture.
 *
 * This provider holds interface state. It never decides anything financial:
 * risk, timing and authorization all arrive from the services.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import type { PipelineStepName } from "@/lib/types";
import type { AnalysisResponse } from "@/lib/services/contracts";
import { analyzeInvoice } from "@/lib/services/analysisService";
import {
  CONNECT_STAGES,
  detectInvoices,
  type ConnectStageId,
  type DetectedInvoice,
} from "@/lib/services/inboxService";
import {
  executePayment as submitPayment,
  EXECUTION_STAGES,
  type ExecutionReceipt,
  type ExecutionStageId,
} from "@/lib/services/suiService";
import { signInWithGoogle, type TreasurySession } from "@/lib/services/authService";
import { AS_OF_DATE } from "@/lib/services/treasuryService";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type InboxStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED";

export type InvoiceStatus =
  | "DETECTED"
  | "ANALYZING"
  | "ANALYZED"
  | "EXECUTING"
  | "PAID"
  | "FAILED";

export interface InvoiceRun {
  status: InvoiceStatus;
  analysis: AnalysisResponse | null;
  error: string | null;
  receipt: ExecutionReceipt | null;
  /** Pipeline steps already reported, for the live progress list. */
  completedSteps: PipelineStepName[];
  executionStage: ExecutionStageId | null;
}

export type ActivityScope = "SYSTEM" | "INBOX" | "AI" | "CHAIN";

export interface ActivityEvent {
  id: string;
  at: string;
  scope: ActivityScope;
  title: string;
  detail: string | null;
  invoiceId: string | null;
  tone: "neutral" | "positive" | "warning" | "negative";
}

export type DemoSpeed = "instant" | "brisk" | "cinematic";

export interface PayflowState {
  hydrated: boolean;
  session: TreasurySession | null;
  inboxStatus: InboxStatus;
  connectStage: ConnectStageId | null;
  completedConnectStages: ConnectStageId[];
  invoices: DetectedInvoice[];
  runs: Record<string, InvoiceRun>;
  activeInvoiceId: string | null;
  activity: ActivityEvent[];
  speed: DemoSpeed;
}

const EMPTY_RUN: InvoiceRun = {
  status: "DETECTED",
  analysis: null,
  error: null,
  receipt: null,
  completedSteps: [],
  executionStage: null,
};

const INITIAL_STATE: PayflowState = {
  hydrated: false,
  session: null,
  inboxStatus: "DISCONNECTED",
  connectStage: null,
  completedConnectStages: [],
  invoices: [],
  runs: {},
  activeInvoiceId: null,
  activity: [],
  speed: "brisk",
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { type: "HYDRATE"; state: Partial<PayflowState> }
  | { type: "SIGN_IN"; session: TreasurySession }
  | { type: "SIGN_OUT" }
  | { type: "CONNECT_START" }
  | { type: "CONNECT_STAGE"; stage: ConnectStageId }
  | { type: "CONNECT_DONE"; invoices: DetectedInvoice[] }
  | { type: "RUN_PATCH"; invoiceId: string; patch: Partial<InvoiceRun> }
  | { type: "RUN_STEP"; invoiceId: string; step: PipelineStepName }
  | { type: "SET_ACTIVE"; invoiceId: string | null }
  | { type: "ACTIVITY"; events: ActivityEvent[] }
  | { type: "SET_SPEED"; speed: DemoSpeed }
  | { type: "RESET" };

let activitySeq = 0;

function stamp(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function activityEvent(
  scope: ActivityScope,
  title: string,
  detail: string | null = null,
  invoiceId: string | null = null,
  tone: ActivityEvent["tone"] = "neutral",
): ActivityEvent {
  activitySeq += 1;
  return {
    id: `evt_${Date.now()}_${activitySeq}`,
    at: stamp(),
    scope,
    title,
    detail,
    invoiceId,
    tone,
  };
}

/**
 * A snapshot can be written mid-flight and restored after a reload, when the
 * work it describes is long gone. Anything that was in progress is rewound to
 * its last durable state so it can be picked up again — otherwise an invoice
 * reads "Analyzing" forever and nothing ever moves it.
 */
function reviveRuns(runs: Record<string, InvoiceRun>): Record<string, InvoiceRun> {
  return Object.fromEntries(
    Object.entries(runs).map(([id, run]) => {
      if (run.status === "ANALYZING") {
        return [id, { ...run, status: "DETECTED" as const, completedSteps: [] }];
      }
      if (run.status === "EXECUTING") {
        return [
          id,
          {
            ...run,
            status: (run.analysis ? "ANALYZED" : "DETECTED") as InvoiceStatus,
            executionStage: null,
          },
        ];
      }
      return [id, run];
    }),
  );
}

function reducer(state: PayflowState, action: Action): PayflowState {
  switch (action.type) {
    case "HYDRATE": {
      const next = { ...state, ...action.state, hydrated: true };
      return { ...next, runs: reviveRuns(next.runs ?? {}) };
    }

    case "SIGN_IN":
      return { ...state, session: action.session };

    case "SIGN_OUT":
      return { ...INITIAL_STATE, hydrated: true, speed: state.speed };

    case "CONNECT_START":
      return {
        ...state,
        inboxStatus: "CONNECTING",
        connectStage: null,
        completedConnectStages: [],
      };

    case "CONNECT_STAGE":
      return {
        ...state,
        connectStage: action.stage,
        completedConnectStages: state.completedConnectStages.includes(action.stage)
          ? state.completedConnectStages
          : [...state.completedConnectStages, action.stage],
      };

    case "CONNECT_DONE":
      return {
        ...state,
        inboxStatus: "CONNECTED",
        connectStage: null,
        invoices: action.invoices,
        runs: Object.fromEntries(
          action.invoices.map((invoice) => [invoice.id, { ...EMPTY_RUN }]),
        ),
      };

    case "RUN_PATCH":
      return {
        ...state,
        runs: {
          ...state.runs,
          [action.invoiceId]: {
            ...(state.runs[action.invoiceId] ?? EMPTY_RUN),
            ...action.patch,
          },
        },
      };

    case "RUN_STEP": {
      const current = state.runs[action.invoiceId] ?? EMPTY_RUN;
      if (current.completedSteps.includes(action.step)) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [action.invoiceId]: {
            ...current,
            completedSteps: [...current.completedSteps, action.step],
          },
        },
      };
    }

    case "SET_ACTIVE":
      return { ...state, activeInvoiceId: action.invoiceId };

    case "ACTIVITY":
      return { ...state, activity: [...action.events, ...state.activity].slice(0, 300) };

    case "SET_SPEED":
      return { ...state, speed: action.speed };

    case "RESET":
      return { ...INITIAL_STATE, hydrated: true, session: state.session, speed: state.speed };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PayflowContextValue {
  state: PayflowState;
  asOfDate: string;
  signIn: () => Promise<void>;
  signOut: () => void;
  connectInbox: () => Promise<void>;
  analyzeAll: () => Promise<void>;
  analyzeOne: (invoiceId: string) => Promise<void>;
  executeInvoicePayment: (invoiceId: string) => Promise<void>;
  setActiveInvoice: (invoiceId: string | null) => void;
  setSpeed: (speed: DemoSpeed) => void;
  reset: () => void;
  log: (event: ActivityEvent) => void;
}

const PayflowContext = createContext<PayflowContextValue | null>(null);

const STORAGE_KEY = "payflow.demo.v1";
const SPEED_FACTOR: Record<DemoSpeed, number> = {
  instant: 0,
  brisk: 0.5,
  cinematic: 1,
};
/** How many analyses may be in flight at once. Keeps a live model honest. */
const ANALYSIS_CONCURRENCY = 3;

const wait = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

const STEP_LABELS: Record<PipelineStepName, string> = {
  extract: "Invoice data extracted",
  supplier: "Supplier verified against registry",
  validate: "Invoice validated",
  forecast: "Cash-flow forecast completed",
  policy_read: "On-chain policy read",
  analysis: "Fact sheet frozen and handed to the AI",
  ai_decision: "AI decision returned",
  policy_enforce: "Sui policy validation",
};

export function PayflowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  /**
   * Latest committed state, for callbacks that outlive the render that created
   * them. Updated in an effect rather than during render — and callers that
   * need data React has not committed yet are passed it directly instead.
   */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** Ids currently being analyzed, so nothing is analyzed twice at once. */
  const inFlight = useRef(new Set<string>());

  // ---- persistence -------------------------------------------------------
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PayflowState>;
        dispatch({ type: "HYDRATE", state: { ...parsed, connectStage: null } });
        return;
      }
    } catch {
      // A corrupt snapshot must never block the demo.
    }
    dispatch({ type: "HYDRATE", state: {} });
  }, []);

  useEffect(() => {
    if (!state.hydrated) return;
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...state, hydrated: false, connectStage: null }),
      );
    } catch {
      // Storage being unavailable is not a demo-stopping problem.
    }
  }, [state]);

  const log = useCallback((event: ActivityEvent) => {
    dispatch({ type: "ACTIVITY", events: [event] });
  }, []);

  const logMany = useCallback((events: ActivityEvent[]) => {
    dispatch({ type: "ACTIVITY", events });
  }, []);

  const factor = SPEED_FACTOR[state.speed];

  // ---- auth --------------------------------------------------------------
  const signIn = useCallback(async () => {
    const session = await signInWithGoogle();
    dispatch({ type: "SIGN_IN", session });
    log(
      activityEvent(
        "SYSTEM",
        "Treasury session opened",
        `zkLogin session for ${session.companyName} · ${session.address.slice(0, 10)}…`,
        null,
        "positive",
      ),
    );
  }, [log]);

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up.
    }
    dispatch({ type: "SIGN_OUT" });
  }, []);

  // ---- analysis ----------------------------------------------------------
  const runAnalysis = useCallback(
    async (invoice: DetectedInvoice) => {
      const invoiceId = invoice.id;
      // A queue run and a detail-page visit can both ask for the same invoice.
      if (inFlight.current.has(invoiceId)) return;
      inFlight.current.add(invoiceId);

      dispatch({
        type: "RUN_PATCH",
        invoiceId,
        patch: { status: "ANALYZING", error: null, completedSteps: [] },
      });
      log(
        activityEvent(
          "AI",
          `Analysis started · ${invoice.invoiceNumber}`,
          `${invoice.supplierName} — deterministic facts being assembled`,
          invoiceId,
        ),
      );

      try {
        const result = await analyzeInvoice(invoice.scenarioId);

        // Replay the pipeline steps so the interface shows the work happening
        // rather than a result appearing from nowhere.
        for (const step of result.steps) {
          await wait(150 * factor);
          dispatch({ type: "RUN_STEP", invoiceId, step: step.name });
        }

        dispatch({
          type: "RUN_PATCH",
          invoiceId,
          patch: { status: "ANALYZED", analysis: result },
        });

        const decision = result.decision;
        const events: ActivityEvent[] = [
          activityEvent(
            "AI",
            `AI recommended ${decision.action.replace("_", " ")}`,
            [
              `Risk ${decision.risk}`,
              `urgency ${decision.urgency}`,
              decision.recommendedDate ? `date ${decision.recommendedDate}` : null,
              `confidence ${(decision.confidence * 100).toFixed(0)}%`,
            ]
              .filter(Boolean)
              .join(" · "),
            invoiceId,
            decision.action === "REJECT" ? "negative" : "neutral",
          ),
        ];

        if (result.enforcement) {
          const approved = result.enforcement.outcome === "APPROVED";
          events.push(
            activityEvent(
              "CHAIN",
              approved
                ? "Sui policy validation passed"
                : "Sui policy validation REJECTED the payment",
              approved
                ? `${result.enforcement.checks.length} on-chain assertions satisfied`
                : result.enforcement.violations.map((violation) => violation.code).join(", "),
              invoiceId,
              approved ? "positive" : "negative",
            ),
          );
        }
        logMany(events.reverse());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Analysis failed.";
        dispatch({ type: "RUN_PATCH", invoiceId, patch: { status: "FAILED", error: message } });
        log(
          activityEvent(
            "AI",
            `Analysis failed · ${invoice.invoiceNumber}`,
            message,
            invoiceId,
            "negative",
          ),
        );
      } finally {
        inFlight.current.delete(invoiceId);
      }
    },
    [factor, log, logMany],
  );

  /**
   * Runs a fixed list through a small worker pool.
   *
   * The list is passed in rather than read from state: the caller often has
   * invoices that React has not committed yet, and reading a stale ref here
   * silently analyzed nothing.
   */
  const analyzeQueue = useCallback(
    async (invoices: DetectedInvoice[]) => {
      if (invoices.length === 0) return;
      const queue = [...invoices];
      const workers = Array.from(
        { length: Math.min(ANALYSIS_CONCURRENCY, queue.length) },
        async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) return;
            await runAnalysis(next);
          }
        },
      );
      await Promise.all(workers);
    },
    [runAnalysis],
  );

  const analyzeOne = useCallback(
    async (invoiceId: string) => {
      const invoice = stateRef.current.invoices.find((item) => item.id === invoiceId);
      if (!invoice) return;
      const run = stateRef.current.runs[invoiceId];
      if (run?.status === "ANALYZING") return;
      await runAnalysis(invoice);
    },
    [runAnalysis],
  );

  const analyzeAll = useCallback(async () => {
    const pending = stateRef.current.invoices.filter((invoice) => {
      const run = stateRef.current.runs[invoice.id];
      return !run || run.status === "DETECTED" || run.status === "FAILED";
    });
    await analyzeQueue(pending);
  }, [analyzeQueue]);

  // ---- inbox -------------------------------------------------------------
  const connectInbox = useCallback(async () => {
    if (stateRef.current.inboxStatus === "CONNECTING") return;
    dispatch({ type: "CONNECT_START" });
    log(
      activityEvent(
        "INBOX",
        "Finance inbox connection requested",
        "Demo adapter (Gmail-compatible)",
      ),
    );

    for (const stage of CONNECT_STAGES) {
      dispatch({ type: "CONNECT_STAGE", stage: stage.id });
      await wait(stage.durationMs * factor);
    }

    const invoices = await detectInvoices(AS_OF_DATE);
    dispatch({ type: "CONNECT_DONE", invoices });
    logMany([
      activityEvent(
        "INBOX",
        `${invoices.length} supplier invoices detected`,
        invoices.map((invoice) => invoice.invoiceNumber).join(", "),
        null,
        "positive",
      ),
      activityEvent(
        "INBOX",
        "Finance inbox connected",
        "Scanning enabled for incoming invoices",
        null,
        "positive",
      ),
    ]);

    void analyzeQueue(invoices);
  }, [analyzeQueue, factor, log, logMany]);

  // ---- execution ---------------------------------------------------------
  const executeInvoicePayment = useCallback(
    async (invoiceId: string) => {
      const run = stateRef.current.runs[invoiceId];
      const request = run?.analysis?.paymentRequest;
      const enforcement = run?.analysis?.enforcement;
      // Execution is gated on the chain's answer, never on the AI's.
      if (!request || enforcement?.outcome !== "APPROVED") return;

      dispatch({ type: "RUN_PATCH", invoiceId, patch: { status: "EXECUTING" } });

      for (const stage of EXECUTION_STAGES) {
        dispatch({ type: "RUN_PATCH", invoiceId, patch: { executionStage: stage.id } });
        await wait(stage.durationMs * factor);
      }

      const receipt = await submitPayment(request);
      dispatch({
        type: "RUN_PATCH",
        invoiceId,
        patch: { status: "PAID", receipt, executionStage: null },
      });
      log(
        activityEvent(
          "CHAIN",
          `Payment executed · ${request.invoiceNumber}`,
          `${receipt.digest.slice(0, 18)}… · sponsored transaction · epoch ${receipt.epoch}`,
          invoiceId,
          "positive",
        ),
      );
    },
    [factor, log],
  );

  /**
   * Picks up work a reload interrupted. Runs once per mount: a failing
   * analysis must not be retried in a loop.
   */
  const resumed = useRef(false);
  useEffect(() => {
    if (!state.hydrated || resumed.current) return;
    if (state.inboxStatus !== "CONNECTED") return;
    resumed.current = true;
    const pending = state.invoices.filter(
      (invoice) => (state.runs[invoice.id]?.status ?? "DETECTED") === "DETECTED",
    );
    if (pending.length > 0) void analyzeQueue(pending);
  }, [analyzeQueue, state.hydrated, state.inboxStatus, state.invoices, state.runs]);

  const setActiveInvoice = useCallback((invoiceId: string | null) => {
    dispatch({ type: "SET_ACTIVE", invoiceId });
  }, []);

  const setSpeed = useCallback((speed: DemoSpeed) => {
    dispatch({ type: "SET_SPEED", speed });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
    log(activityEvent("SYSTEM", "Demo state reset", "Inbox disconnected, analyses cleared"));
  }, [log]);

  const value = useMemo<PayflowContextValue>(
    () => ({
      state,
      asOfDate: AS_OF_DATE,
      signIn,
      signOut,
      connectInbox,
      analyzeAll,
      analyzeOne,
      executeInvoicePayment,
      setActiveInvoice,
      setSpeed,
      reset,
      log,
    }),
    [
      state,
      signIn,
      signOut,
      connectInbox,
      analyzeAll,
      analyzeOne,
      executeInvoicePayment,
      setActiveInvoice,
      setSpeed,
      reset,
      log,
    ],
  );

  return <PayflowContext.Provider value={value}>{children}</PayflowContext.Provider>;
}

export function usePayflow(): PayflowContextValue {
  const context = useContext(PayflowContext);
  if (!context) throw new Error("usePayflow must be used inside <PayflowProvider>.");
  return context;
}

export function useInvoiceRun(invoiceId: string | null): InvoiceRun | null {
  const { state } = usePayflow();
  if (!invoiceId) return null;
  return state.runs[invoiceId] ?? null;
}

export { STEP_LABELS, EMPTY_RUN };
