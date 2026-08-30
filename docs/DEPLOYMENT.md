# Deploying AI PayFlow to Sui Testnet

Everything here targets **testnet**. The scripts refuse to run on mainnet, and
that refusal is not a flag you can pass around — it is a hard check in
`scripts/lib/suiCli.ts`.

## What signs transactions

The `sui` CLI keystore, and nothing else. No script in this repo reads a private
key, derives one, accepts one as an argument, or writes one to a file. The
deployment manifest contains object identifiers only.

## Prerequisites

| | |
|---|---|
| Sui CLI | 1.78.1 (`sui --version`) |
| Active env | `testnet` (`sui client active-env`) |
| Active address | funded with at least ~0.7 SUI |
| Node | 24.x, with `npx tsx` available |

The CLI is installed at `C:\Users\xuzhe\.local\bin\sui.exe` and is on the user
PATH. A new shell picks it up automatically.

### Funding the address

```bash
sui client active-address          # confirm which address you are funding
sui client faucet                  # testnet faucet, or use https://faucet.sui.io
sui client gas                     # confirm the balance arrived
```

> The keypair the CLI generated automatically during package scaffolding had its
> recovery phrase printed to a terminal and is considered compromised. It has
> been replaced, is unfunded, and must never be used. If you need another
> address, create it with `sui client new-address ed25519` and switch to it —
> do not reuse the original.

## The pipeline

Each step is a dry run by default and prints exactly what it would do. Nothing
reaches the chain without `--confirm`.

```
npm run move:build          # compiles the package                     (offline)
npm run move:test           # 34 tests, all security scenarios          (offline)
npm run deploy              # preflight + plan, no transactions         (reads chain for gas)
npm run deploy -- --confirm # publishes, creates objects, writes manifest
npm run seed                # plan only
npm run seed -- --confirm   # suppliers, funding, invoices, cash-flow events
npm run verify:deployment   # reads back and dry-runs Scenario B
```

`deploy` re-runs the Move build and the full test suite itself and **refuses to
publish** if any test fails or if the suite has shrunk below 34 tests. You
cannot deploy a package whose security tests are not passing.

## What each step creates

**`deploy --confirm`**

1. Publishes the package. `mock_usdc::init` runs during publish, producing the
   mint capability and frozen coin metadata.
2. `treasury::create_and_transfer` — shares the Treasury, transfers the owner
   capability to the publisher.
3. `registry::create`, `cashflow::create` — the two other shared objects.
4. `agent::issue_to`, `approval::issue_approver_to` — the capabilities.
5. Writes `deployments/testnet.json`.

**`seed --confirm`**

1. `registry::upsert` for the five demo suppliers (idempotent — it overwrites).
2. Mints $100,000 MOCK_USDC and deposits it into the vault.
3. Creates the eight demo invoices.
4. Adds the six cash-flow events.
5. Records what it created back into the manifest.

Re-running `seed` skips anything already recorded and tells you so. `--force`
overrides that and will create a second set of invoices — you almost never want
this.

## The manifest

`deployments/testnet.json` is the single place object IDs live. Nothing in the
application may hardcode one; `lib/sui/deployment.ts` is the typed reader.

Two IDs a reader might expect are deliberately absent:

- **No `policyId`.** `TreasuryPolicy` is stored by value inside the Treasury —
  it has no independent lifecycle, and inlining it makes "read the policy" a
  single object fetch. Read it from `treasuryId`.
- **No `agentAuthorizationId`.** An agent's limits are a table entry inside the
  Treasury, keyed by the AgentCap's object id. That is precisely what lets the
  admin revoke an agent whose capability object it does not hold. Read them from
  `treasuryId`, keyed by `agentCapId`.

## Source of truth

Bootstrap values come from `lib/demo/policies.ts` — the same constants the
pipeline already uses, so the repo has one set of literals rather than two.

**After deployment, the chain is authoritative.** `initialPolicy` in the
manifest is provenance, not current state. If the manifest and the chain
disagree, the chain is right, and the interface must read the live policy from
the treasury. Wiring that read is Phase D.

Canonical demo policy:

| | |
|---|---|
| Max autonomous AI payment | $5,000 |
| Daily autonomous limit | $20,000 |
| Human approval threshold | $5,000 |
| Minimum reserve | $50,000 |
| Vault funding | $100,000 |

## The demo scenarios

| Scenario | Invoice | Path | Expected |
|---|---|---|---|
| **A0** autonomous | INV-2026-3455, $3,000 | agent's own capability | executes |
| **A** cash-flow timing | INV-2026-3461, $30,000 | AI recommends → human approves → chain executes | executes under approval; **never** labelled autonomous |
| **B** AI overruled | INV-2026-3492, $8,000 | agent's own capability | **abort 5**, `EXCEEDS_MAX_PAYMENT` |
| **C** stale recommendation | A's invoice, after a −$40,000 outflow | scheduled, revalidated at execution | **abort 9**, `INSUFFICIENT_RESERVE` |

`tests/sui/demoScenarios.test.ts` asserts the *exact* violation set for each, so
Scenario B cannot quietly start failing for a different reason and still look
right on screen. If a check other than the intended one fires, **fix the seed
data — never loosen the policy to make a demo pass.**

## Verification after deployment

`npm run verify:deployment` reads every object back, compares the on-chain
policy against the manifest, and **dry-runs** Scenario B to confirm the chain
refuses it with abort code 5. A dry run costs no gas and changes nothing, so it
is safe to repeat.

To capture a real transaction digest for the presentation:

```bash
npx tsx scripts/verifyDeployment.ts --demo-b
```

That submits the $8,000 payment for real. **It is expected to fail** — the
failure, and its digest, are the artifact.

## Not in this phase

zkLogin, Enoki sponsorship, and Walrus are deliberately out of scope here. The
package and the demo data do not depend on them.
