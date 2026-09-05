# Running AI PayFlow

Setup, environment, and the day-to-day commands. For what the system _is_, see
the [README](../README.md); for publishing to testnet, [DEPLOYMENT.md](DEPLOYMENT.md).

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

Open http://localhost:3000. The app runs without any AI credentials — but every
invoice then escalates via the safety fallback and is clearly labelled as such,
which is not an AI demo.

## Environment

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

## Development

```bash
npm run dev           # Next.js dev server
npm run typecheck     # tsc --noEmit
npm run lint
npm run test          # vitest, offline
npm run test:live     # the tests that talk to testnet / the providers
npm run build         # typecheck + next build
```

## Chain

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
itself and refuses to publish if any fail. Full detail, including the object
graph and what each step creates: [DEPLOYMENT.md](DEPLOYMENT.md).

## Exercising the pipeline

```bash
npm run scenarios               # all eight scenarios through the real pipeline, as a table
npm run scenarios -- --replay   # same, from recordings, no network
npm run demo:a                  # scripted walkthroughs
npm run demo:b
npm run check:ai                # verify the Workers AI credentials with one minimal call
npm run prompt -- s2_cashflow   # print the exact fact sheet a scenario sends the model
```
