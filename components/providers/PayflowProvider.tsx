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
import type { AnalysisResponse, ApprovalResponse } from "@/lib/services/contracts";
import { approvePayment } from "@/lib/services/approvalService";
import { analyzeInvoice } from "@/lib/services/analysisService";
import {
  CONNECT_STAGES,
  type ConnectStageId,
  type DetectedInvoice,
} from "@/lib/services/inboxService";
import { listInvoices } from "@/lib/services/invoiceListService";
import { refreshChainInvoices } from "@/components/hooks/useChainInvoice";
import {
  executePayment as submitPayment,
  readExecutionMode,
  EXECUTION_STAGES,
  PaymentRefusedError,
  type ExecutionMode,
  type ExecutionReceipt,
  type ExecutionStageId,
  type PaymentAuthority,
} from "@/lib/services/suiService";
import {
  restoreIdentity,
  sessionFromIdentity,
  signOutIdentity,
  type TreasurySession,
} from "@/lib/services/authService";
import type { AuthenticatedIdentity } from "@/lib/identity/authorization";
import { AS_OF_DATE } from "@/lib/services/treasuryService";
import { decideAutonomy, shouldActAutonomously } from "@/lib/payments/autonomy";

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

/**
 * A payment that was attempted and did not settle.
 *
 * KEPT SEPARATE FROM `error`, which means "the analysis failed" and is rendered
 * only for a FAILED run. An execution failure leaves the run ANALYZED — the
 * analysis is still good, the invoice is still payable — so it was stored in
 * that same field and then never displayed by anything. The button ticked
 * through five stages and reset itself with nothing said.
 */
export interface ExecutionFailure {
  /** A stable identifier: a policy check, or why the server would not submit. */
  code: string;
  message: string;
  /** The Move abort code, when Sui refused. */
  abortCode: number | null;
  /**
   * A digest here means a REAL transaction was rejected on chain — it reached
   * consensus and consumed gas. Its absence means nothing was ever submitted.
   * The two are different facts and the interface says which.
   */
  digest: string | null;
  explorerUrl: string | null;
  at: string;
}

export interface InvoiceRun {
  status: InvoiceStatus;
  analysis: AnalysisResponse | null;
  error: string | null;
  /** Why the last execution attempt did not settle. Cleared when one starts. */
  executionFailure: ExecutionFailure | null;
  receipt: ExecutionReceipt | null;
  /** Pipeline steps already reported, for the live progress list. */
  completedSteps: PipelineStepName[];
  executionStage: ExecutionStageId | null;
  /**
   * Set only when a HUMAN has approved an escalated payment.
   *
   * This is what gives an escalated invoice a PaymentRequest at all — the agent
   * cannot produce one, because buildPaymentRequest refuses to build for
   * HUMAN_REVIEW. The enforcement inside it is a full re-run of the ten checks
   * under the approver's limits, so approval widens authority without skipping
   * a single rule.
   */
  approval: ApprovalResponse | null;
  /** A human declining the payment outright. Stops the workflow. */
  humanRejected: boolean;
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
  /**
   * Whether the server will actually submit, asked of the server on load.
   *
   * Held in state so the interface can describe execution accurately BEFORE
   * anyone clicks. "The treasury key will sign this on testnet" and "nothing
   * will be submitted" are different promises, and a build that guessed is how
   * a simulated receipt came to be shown as a real settlement.
   */
  executionMode: ExecutionMode;
}

const EMPTY_RUN: InvoiceRun = {
  status: "DETECTED",
  analysis: null,
  error: null,
  executionFailure: null,
  receipt: null,
  completedSteps: [],
  executionStage: null,
  approval: null,
  humanRejected: false,
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
  // Assumed off until the server says otherwise: an unanswered question must
  // not read as a promise to submit.
  executionMode: { live: false, network: null },
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
  | { type: "EXECUTION_MODE"; mode: ExecutionMode }
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

    case "EXECUTION_MODE":
      return { ...state, executionMode: action.mode };

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
  /** Records an identity the callback established. Sign-in is a redirect. */
  adoptIdentity: (identity: AuthenticatedIdentity) => void;
  signOut: () => void;
  connectInbox: () => Promise<void>;
  analyzeAll: () => Promise<void>;
  analyzeOne: (invoiceId: string) => Promise<void>;
  executeInvoicePayment: (invoiceId: string) => Promise<void>;
  /** A human authorizing a payment the agent may not make alone. */
  approveInvoicePayment: (invoiceId: string) => Promise<void>;
  /** A human declining outright. */
  rejectInvoicePayment: (invoiceId: string) => void;
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

  // ---- execution mode ----------------------------------------------------
  // Asked once, on load. The answer changes only when the server restarts with
  // a different configuration, and a restart ends this session anyway.
  useEffect(() => {
    const controller = new AbortController();
    void readExecutionMode(controller.signal).then((mode) => {
      dispatch({ type: "EXECUTION_MODE", mode });
    });
    return () => controller.abort();
  }, []);

  const log = useCallback((event: ActivityEvent) => {
    dispatch({ type: "ACTIVITY", events: [event] });
  }, []);

  const logMany = useCallback((events: ActivityEvent[]) => {
    dispatch({ type: "ACTIVITY", events });
  }, []);

  const factor = SPEED_FACTOR[state.speed];

  // ---- auth --------------------------------------------------------------
  //
  // Sign-in no longer happens here. It is a redirect out to Google and back
  // into /auth/callback, so this only records the identity the callback
  // established. A session asserts WHO signed in and deliberately not which
  // company they belong to — that is the chain's to answer, and
  // `useAuthorization` asks it.
  const adoptIdentity = useCallback(
    (identity: AuthenticatedIdentity) => {
      const session = sessionFromIdentity(identity);
      dispatch({ type: "SIGN_IN", session });
      log(
        activityEvent(
          "SYSTEM",
          "Identity verified",
          `zkLogin derived ${session.address.slice(0, 10)}… from a verified Google credential.`,
          null,
          "positive",
        ),
      );
    },
    [log],
  );

  // A refresh should not force a new sign-in. The identity is restored from
  // this tab; the AUTHORIZATION is not, and is re-read from chain every time.
  useEffect(() => {
    if (state.session) return;
    const identity = restoreIdentity();
    if (identity) dispatch({ type: "SIGN_IN", session: sessionFromIdentity(identity) });
    // Runs once on mount; a later sign-out must not immediately re-restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up.
    }
    // Drops the stored identity and any half-finished sign-in attempt, so a
    // sign-out cannot leave a pending nonce behind for the next one.
    signOutIdentity();
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

        // ANALYSIS ENDS HERE. It establishes that the agent is AUTHORIZED to
        // settle this payment; it does not settle it.
        //
        // An earlier version fired the payment from this point, which made the
        // interface claim "executing" on an invoice where no transaction
        // existed. Authorization and execution are different facts and the
        // screen must be able to show the first without asserting the second —
        // so the payment is submitted when someone submits it, and until then
        // the outcome box reads "Approved · ready to execute".
        const autonomy = decideAutonomy({
          action: result.decision.action,
          finalOutcome: result.finalOutcome,
          hasPaymentRequest: result.paymentRequest !== null,
          enforcement: result.enforcement,
          conditional: false,
        });

        if (shouldActAutonomously(autonomy)) {
          log(
            activityEvent(
              "CHAIN",
              `Approved for autonomous execution · ${invoice.invoiceNumber}`,
              autonomy.kind === "AUTONOMOUS" ? autonomy.reason : "",
              invoiceId,
              "positive",
            ),
          );
        }
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

    // Membership comes from the chain, so an invoice created after the seed
    // appears without anyone adding it to a fixture.
    const listed = await listInvoices();
    const invoices = listed.invoices;
    dispatch({ type: "CONNECT_DONE", invoices });
    if (!listed.fromChain && listed.reason) {
      log(
        activityEvent(
          "SYSTEM",
          "Invoice list fell back to local fixtures",
          `${listed.reason} Invoices created on chain after the seed may be missing.`,
          null,
          "negative",
        ),
      );
    }
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

  // ---- human approval ------------------------------------------------------

  /**
   * A treasury operator authorizing a payment the agent may not make alone.
   *
   * This does NOT execute. It asks the server to re-run the ten policy checks
   * under the approver's limits and stores the result; execution remains a
   * separate, explicit step, and still refuses unless that enforcement came
   * back APPROVED. A human can grant authority the agent lacks — they cannot
   * grant authority the treasury withholds from everyone.
   */
  const approveInvoicePayment = useCallback(
    async (invoiceId: string) => {
      const run = stateRef.current.runs[invoiceId];
      const scenarioId = stateRef.current.invoices.find(
        (invoice) => invoice.id === invoiceId,
      )?.scenarioId;
      if (!run?.analysis || !scenarioId || run.humanRejected) return;

      try {
        const approval = await approvePayment(scenarioId);
        dispatch({ type: "RUN_PATCH", invoiceId, patch: { approval } });

        const approved = approval.enforcement.outcome === "APPROVED";
        log(
          activityEvent(
            "CHAIN",
            approved
              ? `Human approved ${approval.paymentRequest.invoiceNumber}`
              : `Approval would be refused by Sui for ${approval.paymentRequest.invoiceNumber} — nothing submitted`,
            approved
              ? "Re-checked under the approver's limits; every on-chain rule still passed."
              : approval.enforcement.violations.map((violation) => violation.detail).join(" "),
            invoiceId,
            approved ? "positive" : "negative",
          ),
        );
      } catch (error) {
        dispatch({
          type: "RUN_PATCH",
          invoiceId,
          patch: {
            error: error instanceof Error ? error.message : "Approval could not be evaluated.",
          },
        });
      }
    },
    [log],
  );

  /** A human declining outright. No transaction, and the workflow stops. */
  const rejectInvoicePayment = useCallback(
    (invoiceId: string) => {
      const run = stateRef.current.runs[invoiceId];
      if (!run?.analysis) return;
      dispatch({
        type: "RUN_PATCH",
        invoiceId,
        patch: { humanRejected: true, approval: null },
      });
      log(
        activityEvent(
          "SYSTEM",
          `Operator declined ${run.analysis.analysis.invoiceFacts.invoiceNumber}`,
          "No payment request was submitted to the chain.",
          invoiceId,
          "warning",
        ),
      );
    },
    [log],
  );

  // ---- execution ---------------------------------------------------------
  /**
   * Held in a ref because analysis runs before this callback is defined, and
   * reordering the file to satisfy the closure would be a worse trade than one
   * ref with a comment explaining it.
   */
  const executeRef = useRef<((invoiceId: string) => Promise<void>) | null>(null);

  const executeInvoicePayment = useCallback(
    async (invoiceId: string) => {
      const run = stateRef.current.runs[invoiceId];
      // A human-approved payment carries its own request and its own
      // enforcement result, re-run under the approver's limits. Either source
      // is acceptable; an unenforced one never is.
      const request = run?.approval?.paymentRequest ?? run?.analysis?.paymentRequest;
      const enforcement = run?.approval?.enforcement ?? run?.analysis?.enforcement;
      // Gated on the chain's answer — never on the AI's, and never on the mere
      // fact that a human clicked approve.
      if (!request || enforcement?.outcome !== "APPROVED") return;
      if (run?.humanRejected) return;
      // Idempotence. A reload, a second click, or an autonomous run racing a
      // manual one must not pay twice — only an ANALYZED invoice is payable.
      if (run.status === "EXECUTING" || run.status === "PAID") return;

      // WHICH MOVE FUNCTION SETTLES THIS. An approval means the payment is
      // above the agent's authority, so it goes through `execute_approved`
      // against a scoped HumanApproval rather than through the AgentCap. The
      // agent cannot reach that path and a human does not need the cap: the
      // separation is structural, not a flag.
      const authority: PaymentAuthority = run.approval ? "HUMAN_APPROVAL" : "AGENT";

      dispatch({
        type: "RUN_PATCH",
        invoiceId,
        // The previous failure goes at the START of the retry, not at its end.
        // Leaving it up while the stages tick would attribute an old refusal to
        // the attempt now running.
        patch: { status: "EXECUTING", executionFailure: null },
      });

      for (const stage of EXECUTION_STAGES) {
        dispatch({ type: "RUN_PATCH", invoiceId, patch: { executionStage: stage.id } });
        await wait(stage.durationMs * factor);
      }

      // The only success path runs on a digest the CHAIN returned. Marking a
      // run PAID on anything else is what reported a $30,000 settlement that
      // never reached a validator, so a refusal is recorded as a refusal, the
      // invoice stays unpaid, and the reason is put on screen.
      try {
        const receipt = await submitPayment(request, authority);
        // THE CACHED INVOICE LIST IS NOW WRONG. It was loaded once for the
        // page and still records this invoice as unpaid; leaving it would let
        // the outcome box offer Execute on something that has just settled.
        // Dropped BEFORE the state change, so anything re-reading in response
        // to it gets the new answer rather than the stale one.
        refreshChainInvoices();
        dispatch({
          type: "RUN_PATCH",
          invoiceId,
          patch: { status: "PAID", receipt, executionStage: null, executionFailure: null },
        });
        log(
          activityEvent(
            "CHAIN",
            `Payment executed · ${request.invoiceNumber}`,
            `${receipt.digest.slice(0, 18)}… · ${
              receipt.checkpoint ? `checkpoint ${receipt.checkpoint}` : "awaiting checkpoint"
            }`,
            invoiceId,
            "positive",
          ),
        );
      } catch (error) {
        // A refusal can ALSO mean the cache is stale — `INVOICE_ALREADY_PAID`
        // says the chain settled this invoice and this browser had not noticed.
        // Re-reading turns the next render into an accurate PAID rather than
        // another Execute button over the same refusal.
        if (error instanceof PaymentRefusedError && error.code === "INVOICE_ALREADY_PAID") {
          refreshChainInvoices();
        }

        const refusal =
          error instanceof PaymentRefusedError
            ? error
            : new PaymentRefusedError(
                "EXECUTION_FAILED",
                error instanceof Error ? error.message : "No payment was submitted.",
              );

        dispatch({
          type: "RUN_PATCH",
          invoiceId,
          patch: {
            // ANALYZED, not FAILED: the analysis is sound and the invoice is
            // still payable. What failed is this attempt.
            status: "ANALYZED",
            executionStage: null,
            executionFailure: {
              code: refusal.code,
              message: refusal.message,
              abortCode: refusal.detail.abortCode,
              digest: refusal.detail.digest,
              explorerUrl: refusal.detail.explorerUrl,
              at: new Date().toISOString(),
            },
          },
        });
        log(
          activityEvent(
            "CHAIN",
            `No payment submitted · ${request.invoiceNumber}`,
            refusal.message,
            invoiceId,
            "negative",
          ),
        );
      }
    },
    [factor, log],
  );

  useEffect(() => {
    executeRef.current = executeInvoicePayment;
  }, [executeInvoicePayment]);

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
      adoptIdentity,
      signOut,
      connectInbox,
      analyzeAll,
      analyzeOne,
      executeInvoicePayment,
      approveInvoicePayment,
      rejectInvoicePayment,
      setActiveInvoice,
      setSpeed,
      reset,
      log,
    }),
    [
      state,
      adoptIdentity,
      signOut,
      connectInbox,
      analyzeAll,
      analyzeOne,
      executeInvoicePayment,
      approveInvoicePayment,
      rejectInvoicePayment,
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
