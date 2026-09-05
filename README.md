# AI PayFlow

**AI analyzes. Sui enforces.**

An autonomous treasury for supplier invoices. Two independent AI providers read
an invoice and the company's cash position and _recommend_ what to do with it.
A Move package on Sui decides what may actually happen — and it does not read
the recommendation.

That split is the whole product. A compromised, hallucinating, or simply wrong
model can produce any recommendation it likes; the worst it achieves is a
transaction the chain refuses. Authority lives in capability objects and a
policy stored inside the treasury, never in the model's output.

---

## The problem

Accounts-payable systems answer one question: **can we pay this?** Balance,
supplier, invoice number — approve or don't. A treasurer asks three:

| Question                               | Answered by                                               |
| -------------------------------------- | --------------------------------------------------------- |
| _Should_ we pay this at all?           | Deterministic checks — registry, PO, duplicates, wallet   |
| _When_ should we pay it?               | The AI layer, forecasting liquidity under candidate dates |
| _Can_ the agent be trusted to execute? | Sui — capability objects and the treasury's own policy    |

Automating the first question is a bot. Automating the second is treasury
optimization. Answering the third anywhere but on-chain is how an autonomous
agent ends up with unlimited access to corporate funds.

## Four outcomes for an invoice

**Pay now** when it is verified and nothing is gained by waiting. **Schedule**
when a later date leaves more headroom — a $30,000 invoice paid on the 6th
projects a $70,000 minimum cash position; the same invoice on the 20th projects
$85,000, and the money is worth more in the meantime. **Hold in escrow** when
the invoice is entirely legitimate but something in the real world (a shipment)
has not happened yet. **Escalate or refuse** when the facts don't hold up, or
when the two models disagree.

---

## The pipeline

```
deterministic facts  ->  AI decision   ->  recommendation  ->  Sui enforcement
"what is true?"          "what to do?"     "what should?"      "what can?"
```

Every invoice goes through that one function (`lib/pipeline.ts`). There is no
per-scenario branch anywhere in it — the scenario only changes the input data,
which is why the eight fixtures below are evidence rather than staging.

The recommendation is a deliberate step rather than a rename: it is always
produced, including for a rejection, and it is advisory. Only `AUTO_PAY` and
`SCHEDULE` go on to become a `PaymentRequest`, the single artifact the chain
ever judges.

---

## Design decisions

**Two models, no forced consensus.** Gemini and Workers AI (Llama) receive the
identical fact sheet, prompt, schema, and return guard, concurrently, and
neither sees the other's answer. What differs is only the vendor, the
credential, the weights, and the network path — so a divergence is about the
model, not about what it was told. A disagreement is not averaged away; it
escalates to a person. A provider that is unconfigured, unreachable, or returns
output the guard rejects is reported as unavailable and never filled in from the
other provider or from a recording. _(`lib/ai/dualAnalysis.ts`)_

**The rules set a ceiling; the model chooses beneath it.** The deterministic
layer computes the most permissive action the facts allow, with no model
involved. The LLM chooses within that and writes the prose. The guard is
monotonic in one direction only — an explainer may be more cautious than the
ceiling, never less — so a model that hallucinates PAY_NOW on a revoked supplier
produces REJECT, and the worst a broken explainer can do is be needlessly
careful. _(`lib/decision/engine.ts`)_

**One rule body, two entry points.** Move aborts on the first failed assertion,
but the interface has to show the whole pass: ten checks, passed and failed
alike. So `payment::evaluate` is non-aborting and returns every result, and
`execute_payment` calls that same body and aborts on the first violation.
Because the body is shared, the report the UI renders and the rule the chain
enforces cannot drift apart — and the abort code _is_ the check code, so a Move
abort decodes straight back to a `PolicyViolationCode` in `lib/types.ts`.
`tests/sui/errorCodeParity.test.ts` keeps the two lists aligned one for one.

**Custody, not flags.** Escrowed funds are a `Balance` inside the escrow object,
and the only function that can move it to the supplier demands a confirmed
oracle attestation. There is no permission bit to flip and no privileged caller
who can skip the check, because the check is not a permission — it is the only
route the coin has. _(`move/payflow/sources/escrow.move`)_

**Anomaly scoring that decides nothing.** Four measured signals with fixed
weights — payment frequency (30), amount deviation (25), recipient
concentration (25), ceiling proximity (20) — summed into one number. No single
signal can reach the trip threshold of 70, so a trip always requires
corroboration from at least three. Nothing is hardcoded for the demo: ordinary
behaviour returns single digits and the attack pattern returns the nineties
because that is what the arithmetic produces. And the score produces only a
_request_ to trip the on-chain breaker, which a human-authorised transaction has
to carry out. Move never sees the number. _(`lib/defense/anomaly.ts`)_

**No seed phrases.** zkLogin turns a Google account into a Sui address; nothing
in the repo reads, derives, or writes a private key, and testnet transactions
are signed by the `sui` CLI keystore alone. _(`lib/identity/`)_

---

## The ten checks

Every payment — agent-initiated or human-approved — is judged by the same ten
assertions, in this order. The number is the Move abort code.

| #   | Code                        | What it asserts                                         |
| --- | --------------------------- | ------------------------------------------------------- |
| 1   | `AGENT_NOT_AUTHORIZED`      | The capability is registered on this treasury           |
| 2   | `CAPABILITY_DISABLED`       | It has not been revoked                                 |
| 3   | `SUPPLIER_NOT_APPROVED`     | The payee is in the on-chain registry                   |
| 4   | `RECIPIENT_WALLET_MISMATCH` | The remit address is the registered one                 |
| 5   | `EXCEEDS_MAX_PAYMENT`       | Inside the single-payment cap for this authority        |
| 6   | `EXCEEDS_DAILY_LIMIT`       | Inside the rolling daily limit                          |
| 7   | `CURRENCY_NOT_ALLOWED`      | The settlement coin is permitted by policy              |
| 8   | `INVOICE_ALREADY_PAID`      | This invoice has not been settled before                |
| 9   | `INSUFFICIENT_RESERVE`      | The vault stays above the minimum reserve afterwards    |
| 10  | `RECOMMENDATION_EXPIRED`    | A scheduled recommendation is still within its validity |

Two sources of authority — an `AgentCap`, or a scoped human approval — resolve
to one `Limits` value, so both paths are judged by identical code. Human
approval raises the bound; it does not skip a check.

---

## Architecture

| Layer                         | Where                            | Responsibility                                                                                                                                                    |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministic analysis**    | `lib/deterministic/`             | Extract the invoice, look up the supplier, match the PO, project cash flow. Facts only — no model involved.                                                       |
| **Intelligence**              | `lib/ai/`                        | Gemini and Cloudflare Workers AI, called concurrently on the identical fact sheet and prompt. Neither sees the other's answer; a disagreement is itself a signal. |
| **Decision & recommendation** | `lib/decision/`, `lib/payments/` | Turns opinions into an advisory recommendation, then into a `PaymentRequest` — the only artifact the chain ever judges.                                           |
| **Enforcement**               | `move/payflow/`                  | Ten checks over one rule body. Aborts are the product working.                                                                                                    |
| **Defense**                   | `lib/defense/`                   | Scores the payment _stream_ (not individual payments) for anomalies and can request an on-chain circuit-breaker trip.                                             |
| **Identity**                  | `lib/identity/`                  | zkLogin: a Google account becomes a Sui address without anyone handling a seed phrase.                                                                            |
| **Interface**                 | `app/`, `components/`            | Next.js App Router. Server-only credentials stay in route handlers under `app/api/`.                                                                              |

The interface is twelve surfaces under `app/(app)/` — dashboard, invoices,
payments, treasury, suppliers, escrow, agent, access, security, defense,
activity, settings — each reading the chain rather than a cached mirror.

### The Move package

`move/payflow/sources/` — every module carries a full design rationale in its
header comment; those are the best entry point into the on-chain logic.

| Module      | What it is                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `treasury`  | The vault, the policy, and the agent register. Money leaves through exactly one `public(package)` door.                                                                                                                  |
| `policy`    | The company's hard financial policy, stored by value inside the treasury. No path from an `AgentCap` reaches it.                                                                                                         |
| `payment`   | The only module that can move funds. `evaluate` is non-aborting and returns all ten check results; `execute_payment` calls that same body and aborts on the first violation, so the UI and the chain cannot drift apart. |
| `limits`    | One `Limits` value, two sources of authority (agent capability, or human approval), so both paths are judged by identical code.                                                                                          |
| `agent`     | `AgentCap` — a bearer token with no mutable field. Its limits live in the treasury so the admin can revoke them.                                                                                                         |
| `approval`  | Scoped, revocable human approval bound to one specific payment. The agent can never mint one.                                                                                                                            |
| `escrow`    | Custody, not flags: funds that have left the treasury and wait on a real-world condition.                                                                                                                                |
| `oracle`    | Who may attest a condition. Holds no funds; attestations are frozen on creation.                                                                                                                                         |
| `registry`  | The approved-supplier register — the authority on who may be paid, and at which address.                                                                                                                                 |
| `cashflow`  | Stores known future cash-flow events. Does no forecasting; that is the AI layer's job and is never accepted as proof.                                                                                                    |
| `identity`  | Company membership. Records what the company _declares_ about a person and grants no spending authority at all.                                                                                                          |
| `mock_usdc` | Six-decimal demo settlement coin, testnet only.                                                                                                                                                                          |

Layering is acyclic: `escrow -> payment -> treasury`. `payment` knows nothing
about escrow; it refuses conditional invoices at the single point its three
entry points share, and `escrow` picks them up.

---

## The scenario catalogue

All eight scenarios share one `TREASURY_POLICY` and one `AGENT_CAPABILITY`, so
a scenario trips a ceiling because its invoice is genuinely larger, never
because its policy was weakened to stage the demo.

| Scenario              | The situation                                              | Outcome                                         |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| `s1_normal`           | Verified $3,000 invoice, due in two days, healthy cash     | `EXECUTED` — inside the agent's cap             |
| `s2_cashflow`         | Legitimate $30,000 against a constrained position          | `SUI_REJECT` — above the approver's $25,000 too |
| `s3_discount`         | 5% early-payment discount expiring today, $4,800           | `EXECUTED` — a $240 discount worth taking       |
| `s4_new_supplier`     | Not in the approved registry, no payment history           | `REJECTED`                                      |
| `s5_wallet_mismatch`  | Approved supplier, unregistered remit wallet — redirection | `REJECTED`                                      |
| `s6_duplicate`        | Invoice number already settled on 2026-08-11               | `REJECTED`                                      |
| `s7_po_mismatch`      | Bills $14,700 against a $9,800 PO — 50% unapproved overage | `HUMAN_REVIEW`                                  |
| `s8_policy_violation` | Clean, well-funded $8,000 invoice                          | `SUI_REJECT` (abort 5) — above the $5,000 cap   |

Scenario fixtures carry **no** expected action, and nothing in `lib/` may read
one — expectations live solely in `tests/expectations.ts`, so the application
cannot short-circuit to the answer. The tests assert the _exact_ violation set,
so a scenario cannot start failing for a different reason and still look right
on screen. If the wrong check fires, fix the seed data — never loosen the policy
to make a demo pass.

### Demo policy

|                           |          |
| ------------------------- | -------- |
| Max autonomous AI payment | $5,000   |
| Daily autonomous limit    | $20,000  |
| Human approval threshold  | $5,000   |
| Approver authorization    | $25,000  |
| Minimum reserve           | $50,000  |
| Vault funding             | $100,000 |

The approver's ceiling is a real on-chain figure read from
`treasury::approver_can_authorize`, not a constant in a TypeScript file — a
distinction that has already cost this project one bug, documented in
`lib/demo/policies.ts`.

---

## What the tests pin down

The Move suite under `move/payflow/tests/` covers the security properties
directly: circuit breaker, approver authorization, policy authority, stale
state, escrow, oracle, identity. The TypeScript suite in `tests/` is grouped by
concern — `tests/sui/` (chain reads, call construction, abort-code parity),
`tests/payments/` (approval state machine, execution path, settlement
precedence), `tests/identity/`, plus the invariant and guard-boundary tests at
the top level.

The invariants worth knowing: an AI recommendation can never become authority;
`deploy` re-runs the Move tests and refuses to publish if any fail; and
`deployments/testnet.json` is the only place object IDs live — nothing in the
application may hardcode one. **After deployment the chain is authoritative**:
if the manifest and the chain disagree, the chain is right.

---

## Layout

```
app/            Next.js App Router — pages under (app)/, server routes under api/
components/     UI, grouped by surface (invoices, payments, defense, escrow, …)
lib/            All non-UI logic; see the architecture table above
move/payflow/   The Sui Move package and its test suite
scripts/        Deploy, seed, verify, record, demo — all dry-run by default
tests/          Vitest suites
docs/           RUNNING.md, DEPLOYMENT.md
deployments/    testnet.json — the object manifest
convex/         Convex backend scaffold
```

## Running it

```bash
npm install && cp .env.example .env.local && npm run dev
```

Setup, environment variables, and the full command list:
[`docs/RUNNING.md`](docs/RUNNING.md). Publishing to testnet:
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
