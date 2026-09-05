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

```
deterministic facts  ->  AI decision   ->  recommendation  ->  Sui enforcement
"what is true?"          "what to do?"     "what should?"      "what can?"
```

Every invoice goes through that one pipeline (`lib/pipeline.ts`). There is no
per-scenario branch anywhere in it — the scenario only changes the input data.

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

---

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

Open http://localhost:3000. The app runs without any AI credentials — but every
invoice then escalates via the safety fallback and is clearly labelled as such,
which is not an AI demo.

### Environment

| Variable                                                           | Needed for          | Notes                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`                    | Workers AI provider | Server-only. Token needs _Workers AI — Read_.                                                                                                            |
| `GEMINI_API_KEY`                                                   | Gemini provider     | Server-only.                                                                                                                                             |
| `PAYFLOW_MODEL`                                                    | optional            | Must support Workers AI JSON mode.                                                                                                                       |
| `PAYFLOW_ENGINE`                                                   | optional            | `live` (default) or `recorded` — replays captured model output through the same guard, labelled "Recorded" in the UI. Refresh with `npm run record:llm`. |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_ZKLOGIN_REDIRECT_URI` | zkLogin sign-in     | Public by design.                                                                                                                                        |
| `PAYFLOW_ZKLOGIN_SALT`                                             | zkLogin sign-in     | **Server-only, never `NEXT_PUBLIC_`.** See the salt-strategy note in `lib/identity/config.ts` before reusing this.                                       |
| `PAYFLOW_PAYMENT_LIVE`                                             | real transactions   | Unset, execution is simulated and says so.                                                                                                               |
| `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOY_KEY`                      | Convex client       | Convex is wired in from the project scaffold; the treasury logic itself lives in Next.js route handlers and on Sui.                                      |

Never prefix a credential with `NEXT_PUBLIC_` — that ships it to the browser.
Every model call happens server-side under `app/api/`.

---

## Sui testnet

Everything targets **testnet**; the scripts refuse to run on mainnet, and that
refusal is a hard check, not a flag. Transactions are signed by the `sui` CLI
keystore and nothing else — no script in this repo reads, derives, or writes a
private key.

```bash
npm run move:build            # compile                                (offline)
npm run move:test             # the full Move security suite           (offline)
npm run deploy                # preflight + plan, no transactions
npm run deploy -- --confirm   # publish, create objects, write the manifest
npm run seed -- --confirm     # suppliers, funding, invoices, cash-flow events
npm run verify:deployment     # read everything back, dry-run Scenario B
```

Every step is a dry run until `--confirm`. `deploy` re-runs the Move tests
itself and refuses to publish if any fail.

`deployments/testnet.json` is the single place object IDs live — nothing in the
application may hardcode one; `lib/sui/deployment.ts` is the typed reader.
**After deployment the chain is authoritative**: if the manifest and the chain
disagree, the chain is right.

Full detail, including the object graph and what each step creates:
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Demo policy

|                           |          |
| ------------------------- | -------- |
| Max autonomous AI payment | $5,000   |
| Daily autonomous limit    | $20,000  |
| Human approval threshold  | $5,000   |
| Minimum reserve           | $50,000  |
| Vault funding             | $100,000 |

### Demo scenarios

| Scenario                   | Path                                              | Expected                                               |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| **A0** autonomous          | agent's own capability                            | executes                                               |
| **A** cash-flow timing     | AI recommends → human approves → chain executes   | executes under approval; **never** labelled autonomous |
| **B** AI overruled         | agent's own capability                            | **abort 5**, `EXCEEDS_MAX_PAYMENT`                     |
| **C** stale recommendation | revalidated at execution after a −$40,000 outflow | **abort 9**, `INSUFFICIENT_RESERVE`                    |

`tests/sui/demoScenarios.test.ts` asserts the _exact_ violation set for each, so
a scenario cannot start failing for a different reason and still look right on
screen. If the wrong check fires, fix the seed data — never loosen the policy to
make a demo pass.

```bash
npm run scenarios     # all eight scenarios through the real pipeline, as a table
npm run scenarios -- --replay   # same, from recordings, no network
npm run demo:a        # scripted walkthroughs
npm run demo:b
npm run check:ai      # verify the Workers AI credentials with one minimal call
npm run prompt -- s2_cashflow   # print the exact fact sheet a scenario sends the model
```

---

## Development

```bash
npm run dev           # Next.js dev server
npm run typecheck     # tsc --noEmit
npm run lint
npm run test          # vitest, offline
npm run test:live     # the tests that talk to testnet / the providers
npm run build         # typecheck + next build
```

The TypeScript suite lives in `tests/`, grouped by concern: `tests/sui/`
(chain reads, call construction, abort-code parity), `tests/payments/`
(approval state machine, execution path, settlement precedence),
`tests/identity/`, plus the invariant and guard-boundary tests at the top level.
`tests/sui/errorCodeParity.test.ts` keeps the Move abort codes and
`PolicyViolationCode` in `lib/types.ts` aligned one for one.

## Layout

```
app/            Next.js App Router — pages under (app)/, server routes under api/
components/     UI, grouped by surface (invoices, payments, defense, escrow, …)
lib/            All non-UI logic; see the architecture table above
move/payflow/   The Sui Move package and its test suite
scripts/        Deploy, seed, verify, record, demo — all dry-run by default
tests/          Vitest suites
docs/           DEPLOYMENT.md
deployments/    testnet.json — the object manifest
convex/         Convex backend scaffold
```
