"use client";

/**
 * Access & authorization: every link between a Google account and a payment.
 *
 * The page is built around one refusal — it will not let the reader believe
 * that signing in, belonging to a company, or holding a role has anything to
 * do with being able to move money. Those are drawn as separate links in a
 * chain, each with its own status, and the fourth link is the only one Move
 * consults:
 *
 *   Google / zkLogin → Chain-Doi → Role → Authorization → Sui Move
 *
 * EVERY FIGURE IS CHAIN-DERIVED. The company, the membership, the role, the
 * permission bitmask and the approver authorization all come from
 * `/api/identity`, which reads the `Company` object and the treasury's own
 * approver record. There is no React-held authorization state anywhere in this
 * file, and the actions below build real transactions rather than setting a
 * flag.
 *
 * WHERE THIS PHASE HONESTLY STOPS. The package upgrade carrying
 * `approve_scoped` has not been published and no authorization has been
 * granted, so the live answer is POLICY_ONLY and every action reports the
 * precise blocker instead of pretending. That is the design working, not a
 * gap: an interface that offered a working Approve button today would be
 * simulating one.
 */

import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge } from "@/components/common/Badge";
import { EmptyState } from "@/components/common/States";
import { LinkButton } from "@/components/common/LinkButton";
import { usePayflow } from "@/components/providers/PayflowProvider";
import { useCurrentAuthorization } from "@/components/hooks/useAuthorization";
import { AuthorityChain, type AuthorityLink } from "@/components/identity/AuthorityChain";
import { MembershipVerification } from "@/components/identity/MembershipVerification";
import { ROLE_LABEL, permissionsFromMask, PERMISSION_LABEL } from "@/lib/identity/permissions";
import {
  checkPayment,
  describeAuthority,
  isCapabilityBacked,
  type PaymentAuthorityState,
} from "@/lib/identity/paymentAuthority";
import { shortAddress } from "@/lib/services/authService";
import { cn } from "@/lib/utils";

/** The demo treasury every figure on this page is measured against. */
const TREASURY_ID = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

export default function AccessPage() {
  const { state: payflow } = usePayflow();
  const { state, paymentAuthority, companyNotDeployed, readAtMs, refresh } =
    useCurrentAuthorization();
  const session = payflow.session;

  if (!session) {
    return (
      <PageContainer>
        <EmptyState
          title="Not signed in"
          description="Sign in with Google to establish an identity. Identity is the first link in the chain and grants nothing on its own."
          action={
            <LinkButton href="/" size="sm" className="rounded-lg">
              Go to sign in
            </LinkButton>
          }
        />
      </PageContainer>
    );
  }

  const authority = paymentAuthority;
  const described = authority ? describeAuthority(authority) : null;
  const backed = authority ? isCapabilityBacked(authority) : false;

  const links: AuthorityLink[] = [
    {
      label: "Google identity",
      establishes: "Proves which human is here. Grants no access to anything.",
      value: session.operatorEmail ?? session.subject,
      status: "ok",
    },
    {
      label: "zkLogin Sui identity",
      establishes:
        "Derives a Sui address from that credential. An address is not an authorization.",
      value: shortAddress(session.address, 10, 6),
      status: "ok",
    },
    {
      label: "Chain-Doi membership",
      establishes:
        "Recorded in the on-chain Company object. An UPPER-LEVEL requirement: Move refuses a " +
        "payment approval while this is inactive, whatever the authorization below says.",
      value:
        state === null
          ? "reading…"
          : state.kind === "AUTHORIZED"
            ? "ACTIVE"
            : state.kind === "REVOKED"
              ? "REVOKED"
              : companyNotDeployed
                ? "no company on chain"
                : "not a member",
      status:
        state === null
          ? "pending"
          : state.kind === "AUTHORIZED"
            ? "ok"
            : state.kind === "REVOKED"
              ? "failed"
              : "warning",
    },
    {
      label: "Role",
      establishes: "What the company calls you. Carries declared permissions, not capabilities.",
      value: state?.kind === "AUTHORIZED" ? ROLE_LABEL[state.membership.role] : "—",
      status: state?.kind === "AUTHORIZED" ? "ok" : "pending",
    },
    {
      label: "Payment authorization",
      establishes:
        "The treasury's own approver record. THE ONLY LINK Move reads before an approval.",
      value: described?.headline ?? "reading…",
      status: !authority
        ? "pending"
        : authority.kind === "ACTIVE"
          ? "ok"
          : authority.kind === "REVOKED" ||
              authority.kind === "EXPIRED" ||
              authority.kind === "MEMBERSHIP_BLOCKS"
            ? "failed"
            : authority.kind === "CHAIN_UNAVAILABLE"
              ? "unknown"
              : "warning",
    },
    {
      label: "Sui Move enforcement",
      establishes:
        "Re-checks every limit when an approval is submitted. The security boundary — not this page.",
      value: backed ? "would evaluate" : "would refuse",
      status: backed ? "ok" : "warning",
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Access & authorization"
        subtitle="Five separate facts between a Google account and a payment. Each is established independently, and only the fourth is something Sui consults."
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <Panel>
          <PanelHeader eyebrow="The chain" title="How authority is established" />
          <PanelBody>
            <AuthorityChain links={links} />
          </PanelBody>
        </Panel>

        <div className="space-y-5">
          <IdentityPanel session={session} />
          <MembershipPanel state={state} companyNotDeployed={companyNotDeployed} />
          <MembershipVerification
            authority={authority}
            address={session.address}
            nowMs={readAtMs}
            onRefreshed={refresh}
          />
          <AuthorizationPanel
            authority={authority}
            described={described}
            backed={backed}
            onRefresh={refresh}
          />
          <ApprovalDemoPanel authority={authority} nowMs={readAtMs} />
        </div>
      </div>
    </PageContainer>
  );
}

// --- 1. identity -------------------------------------------------------------

function IdentityPanel({
  session,
}: {
  session: NonNullable<ReturnType<typeof usePayflow>["state"]["session"]>;
}) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="Identity"
        title="Who is signed in"
        actions={<Badge tone="positive" dot>IDENTITY VERIFIED</Badge>}
      />
      <PanelBody className="space-y-3.5">
        <Row label="Google account" value={session.operatorEmail ?? "—"} />
        <Row label="Google subject" value={session.subject} mono />
        <Row label="zkLogin Sui address" value={session.address} mono />
        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          &ldquo;Identity verified&rdquo; means Google signed a credential for this account and
          zkLogin derived this address from it. It is not a statement about any company,
          treasury, or payment.
        </p>
      </PanelBody>
    </Panel>
  );
}

// --- 2. membership -----------------------------------------------------------

function MembershipPanel({
  state,
  companyNotDeployed,
}: {
  state: ReturnType<typeof useCurrentAuthorization>["state"];
  companyNotDeployed: boolean;
}) {
  const authorized = state?.kind === "AUTHORIZED";
  const revoked = state?.kind === "REVOKED";

  return (
    <Panel tone={authorized ? "positive" : revoked ? "negative" : "default"}>
      <PanelHeader
        eyebrow="Company membership"
        title="Recorded in the on-chain Company object"
        actions={
          <Badge tone={authorized ? "positive" : revoked ? "negative" : "warning"} dot>
            {state === null
              ? "READING"
              : authorized
                ? "ACTIVE"
                : revoked
                  ? "REVOKED"
                  : companyNotDeployed
                    ? "NO COMPANY ON CHAIN"
                    : "NOT A MEMBER"}
          </Badge>
        }
      />
      <PanelBody className="space-y-3.5">
        {state?.kind === "AUTHORIZED" ? (
          <>
            <Row label="Company" value={state.membership.companyName} />
            <Row label="Company object" value={state.membership.companyId} mono />
            <Row label="Bound treasury" value={state.membership.treasuryId} mono />
            <Row label="Role" value={ROLE_LABEL[state.membership.role]} />
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Declared permissions
              </div>
              <ul className="mt-1.5 space-y-1">
                {permissionsFromMask(state.membership.permissionMask).map((permission) => (
                  <li key={permission} className="text-[12.5px] text-ink-soft">
                    · {PERMISSION_LABEL[permission]}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                Company declarations. They say what the company intends; they are not what Move
                checks before a payment.
              </p>
            </div>
          </>
        ) : companyNotDeployed ? (
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            No Company object exists on chain yet, so there is no membership to hold. This is not
            a refusal of your identity.
          </p>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            This address is not recorded as a member of the company.
          </p>
        )}
      </PanelBody>
    </Panel>
  );
}

// --- 3. payment authorization ------------------------------------------------

function AuthorizationPanel({
  authority,
  described,
  backed,
  onRefresh,
}: {
  authority: PaymentAuthorityState | null;
  described: ReturnType<typeof describeAuthority> | null;
  backed: boolean;
  onRefresh: () => void;
}) {
  const auth =
    authority && "authorization" in authority ? authority.authorization : null;

  return (
    <Panel
      tone={
        backed
          ? "positive"
          : authority?.kind === "REVOKED" || authority?.kind === "MEMBERSHIP_BLOCKS"
            ? "negative"
            : "default"
      }
    >
      <PanelHeader
        eyebrow="Payment authorization"
        title="What the treasury records for this address"
        subtitle="The only fact on this page that Sui reads before accepting a payment approval."
        actions={
          <Badge
            tone={
              described?.tone === "positive"
                ? "positive"
                : described?.tone === "negative"
                  ? "negative"
                  : described?.tone === "warning"
                    ? "warning"
                    : "neutral"
            }
            dot
          >
            {authority === null
              ? "READING"
              : authority.kind === "ACTIVE"
                ? "ACTIVE"
                : authority.kind === "REVOKED"
                  ? "REVOKED"
                  : authority.kind === "EXPIRED"
                    ? "EXPIRED"
                    : authority.kind === "MEMBERSHIP_BLOCKS"
                      ? "BLOCKED BY MEMBERSHIP"
                      : authority.kind === "MEMBERSHIP_STALE"
                        ? "VERIFICATION NEEDS REFRESH"
                        : authority.kind === "POLICY_ONLY"
                          ? "NOT CAPABILITY-BACKED"
                          : "NONE"}
          </Badge>
        }
      />
      <PanelBody className="space-y-4">
        {described ? (
          <div
            className={cn(
              "rounded-xl border px-4 py-3",
              described.tone === "positive"
                ? "border-pos/35 bg-pos-soft"
                : described.tone === "negative"
                  ? "border-neg/35 bg-neg-soft"
                  : described.tone === "warning"
                    ? "border-warn/35 bg-warn-soft"
                    : "border-hairline bg-surface-sunken",
            )}
          >
            <div
              className={cn(
                "text-[13.5px] font-semibold",
                described.tone === "positive"
                  ? "text-pos"
                  : described.tone === "negative"
                    ? "text-neg"
                    : described.tone === "warning"
                      ? "text-warn"
                      : "text-ink",
              )}
            >
              {described.headline}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{described.detail}</p>
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-faint">Reading on-chain authorization…</p>
        )}

        {auth ? (
          <>
            <Row label="Maximum single payment" value={money(auth.maxSingleCents)} />
            <Row label="Daily authorization limit" value={money(auth.dailyLimitCents)} />
            <Row label="Authorized today" value={money(auth.authorizedTodayCents)} />
            <Row
              label="Expires"
              value={new Date(auth.expiresAtMs).toISOString().slice(0, 16).replace("T", " ")}
            />
            <Row
              label="Recipient scope"
              value={
                auth.allowedRecipients.length === 0
                  ? "Any recipient, within the limits above"
                  : `${auth.allowedRecipients.length} allowed recipient(s)`
              }
            />
            <Row label="Bound treasury" value={auth.treasuryId} mono />
          </>
        ) : null}

        {/* The claim this page must never make loosely. */}
        <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Capability-backed?
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">
            {backed ? (
              <>
                <strong className="text-pos">Yes.</strong> The treasury holds a live approver
                authorization for this address, and{" "}
                <code className="font-mono text-[11px]">approval::approve_scoped</code> reads it.
              </>
            ) : (
              <>
                <strong className="text-warn">No.</strong> Company policy permission — not yet
                capability-backed. Move would refuse an approval from this address today.
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          className="text-[11.5px] font-medium text-ai underline"
        >
          Re-read from chain
        </button>
      </PanelBody>
    </Panel>
  );
}

// --- 5 & 6. the approval and scope-failure demos ------------------------------

/**
 * Two invoices, the same authorization, opposite answers.
 *
 * Both figures are compared against the CHAIN's recorded limit by the same
 * function the Move module mirrors. Where no authorization exists, both come
 * back refused for the same honest reason — which is the current state.
 */
function ApprovalDemoPanel({
  authority,
  nowMs,
}: {
  authority: PaymentAuthorityState | null;
  nowMs: number | null;
}) {
  if (!authority || nowMs === null) return null;

  const cases = [
    {
      invoice: "INV-2026-3486",
      supplier: "Atlas Precision Works",
      amountCents: 1_470_000,
      recipient: "0x5c8a1f4d7b23e690a4c7f1d85b32e6907a4c1f8d5b23e6907a4c1f8d5b23e690",
    },
    {
      invoice: "INV-2026-3461",
      supplier: "Lumen Fabrication Inc",
      amountCents: 3_000_000,
      recipient: "0x9d4e7b2a8c1f6053e2b7d94a6c81f305b7e29d4a8c16f350b2e7d94a6c81f305",
    },
  ];

  return (
    <Panel>
      <PanelHeader
        eyebrow="Human approval"
        title="What Sui would decide for a specific payment"
        subtitle="Each figure is checked against the authorization recorded on chain. Move re-checks all of it when an approval is submitted."
      />
      <PanelBody className="space-y-3">
        {cases.map((item) => {
          const check = checkPayment({
            state: authority,
            amountCents: item.amountCents,
            recipient: item.recipient,
            treasuryId: TREASURY_ID,
            nowMs,
          });

          return (
            <div
              key={item.invoice}
              className={cn(
                "rounded-xl border px-4 py-3",
                check.wouldAuthorize ? "border-pos/35 bg-pos-soft" : "border-neg/30 bg-neg-soft",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[12.5px] text-ink">{item.invoice}</span>
                <span className="tabular text-[13px] font-semibold text-ink">
                  {money(item.amountCents)}
                </span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-faint">{item.supplier}</div>

              <div className="mt-2.5 flex items-baseline gap-2">
                <span
                  className={cn(
                    "text-[12px]",
                    check.wouldAuthorize ? "text-pos" : "text-neg",
                  )}
                >
                  {check.wouldAuthorize ? "✓" : "✕"}
                </span>
                <span
                  className={cn(
                    "text-[12.5px] font-medium",
                    check.wouldAuthorize ? "text-pos" : "text-neg",
                  )}
                >
                  {check.headline}
                </span>
              </div>

              {check.limitCents !== null && check.refusal === "AMOUNT_EXCEEDS_LIMIT" ? (
                <dl className="mt-2 space-y-0.5 pl-5 text-[11.5px]">
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-faint">Requested amount</dt>
                    <dd className="tabular font-medium text-ink">
                      {money(check.requestedCents ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-faint">Authorization limit</dt>
                    <dd className="tabular font-medium text-ink">{money(check.limitCents)}</dd>
                  </div>
                </dl>
              ) : null}

              <p className="mt-1.5 pl-5 text-[11px] leading-relaxed text-ink-faint">
                {check.detail}
              </p>

              {/* No Approve button is rendered while no authorization exists.
                  A button that could not work would be theatre, and a disabled
                  one would imply the interface is the boundary. */}
              {check.wouldAuthorize ? (
                <p className="mt-2 pl-5 text-[11px] leading-relaxed text-ink-faint">
                  An approval would be submitted as{" "}
                  <code className="font-mono text-[10.5px]">approval::approve_scoped</code>,
                  signed by this zkLogin address, and re-checked by Move.
                </p>
              ) : null}
            </div>
          );
        })}
      </PanelBody>
    </Panel>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </div>
      <div className={cn("mt-1 break-all text-[13px] text-ink", mono && "font-mono text-[11.5px]")}>
        {value}
      </div>
    </div>
  );
}
