"use client";

/**
 * On-chain access: what the chain says about the signed-in human.
 *
 * The page is laid out as four separate claims, in the order they are
 * established, because collapsing them is exactly the misunderstanding this
 * phase exists to prevent:
 *
 *   IDENTITY     Google proves the human
 *   ZKLOGIN      an address is derived from that
 *   COMPANY      the chain records that address as a member
 *   PERMISSIONS  the company declares what that member may do
 *
 * A green tick on "Approve payments" means the company declared it. It does
 * NOT mean Sui would accept an approval from this address — that needs an
 * ApproverCap, which this phase deliberately does not issue. The caveat says
 * so under the tick rather than in a footnote, because a reader who only looks
 * at the ticks would otherwise leave believing something false.
 */

import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge } from "@/components/common/Badge";
import { EmptyState } from "@/components/common/States";
import { LinkButton } from "@/components/common/LinkButton";
import { usePayflow } from "@/components/providers/PayflowProvider";
import { useCurrentAuthorization } from "@/components/hooks/useAuthorization";
import { describeAuthorization } from "@/lib/identity/authorization";
import { ROLE_LABEL, type PermissionStatus } from "@/lib/identity/permissions";
import { cn } from "@/lib/utils";

export default function AccessPage() {
  const { state: payflow } = usePayflow();
  const { state, companyNotDeployed, refresh } = useCurrentAuthorization();
  const session = payflow.session;

  if (!session) {
    return (
      <PageContainer>
        <EmptyState
          title="Not signed in"
          description="Sign in with Google to continue."
          action={
            <LinkButton href="/" size="sm" className="rounded-lg">
              Go to sign in
            </LinkButton>
          }
        />
      </PageContainer>
    );
  }

  const described = state ? describeAuthorization(state) : null;

  return (
    <PageContainer>
      <PageHeader
        title="On-chain access"
        subtitle="Google proves who you are. zkLogin derives your Sui identity. Sui records what your company authorizes."
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="space-y-5">
          {/* --- IDENTITY ------------------------------------------------- */}
          <Panel>
            <PanelHeader eyebrow="Identity" title="Who signed in" />
            <PanelBody className="space-y-4">
              <Row label="Google" value={session.operatorEmail ?? "—"} />
              {session.operatorName ? <Row label="Name" value={session.operatorName} /> : null}
              <Row label="Google subject" value={session.subject} mono />
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                The email identifies you to a reader. It is not the credential — authorization
                resolves from the Sui address below, which is the only part of this a third
                party could verify.
              </p>
            </PanelBody>
          </Panel>

          {/* --- ZKLOGIN IDENTITY ----------------------------------------- */}
          <Panel>
            <PanelHeader eyebrow="zkLogin identity" title="Your Sui address" />
            <PanelBody className="space-y-4">
              <Row label="Sui address" value={session.address} mono />
              <Row label="Issuer" value={session.issuer} />
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                Derived from your Google credential and a server-held salt. No private key and
                no seed phrase is stored by this application, and the salt never reaches your
                browser.
              </p>
            </PanelBody>
          </Panel>

          {/* --- COMPANY --------------------------------------------------- */}
          <Panel
            tone={
              state?.kind === "AUTHORIZED"
                ? "positive"
                : state?.kind === "REVOKED"
                  ? "negative"
                  : "default"
            }
          >
            <PanelHeader
              eyebrow="Company"
              title="On-chain membership"
              actions={
                described ? (
                  <Badge
                    tone={
                      described.tone === "positive"
                        ? "positive"
                        : described.tone === "negative"
                          ? "negative"
                          : described.tone === "warning"
                            ? "warning"
                            : "neutral"
                    }
                    dot
                  >
                    {state?.kind === "AUTHORIZED" ? "ACTIVE" : described.headline}
                  </Badge>
                ) : null
              }
            />
            <PanelBody className="space-y-4">
              {state === null ? (
                <p className="text-[12.5px] text-ink-faint">Reading on-chain authorization…</p>
              ) : state.kind === "AUTHORIZED" ? (
                <>
                  <Row label="Company" value={state.membership.companyName} />
                  <Row label="On-chain company ID" value={state.membership.companyId} mono />
                  <Row label="Bound treasury" value={state.membership.treasuryId} mono />
                  <Row label="Role" value={ROLE_LABEL[state.membership.role]} />
                  <Row label="Member address" value={state.membership.memberAddress} mono />
                </>
              ) : companyNotDeployed ? (
                <div className="rounded-xl border border-hairline bg-surface-sunken px-4 py-3">
                  <div className="text-[12.5px] font-medium text-ink">
                    No company exists on chain yet
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
                    The company identity has not been created. Nobody is a member of anything
                    yet — this is not a refusal of your identity.
                  </p>
                </div>
              ) : (
                <div
                  className={cn(
                    "rounded-xl border px-4 py-3",
                    state.kind === "REVOKED"
                      ? "border-neg/30 bg-neg-soft"
                      : "border-warn/30 bg-warn-soft",
                  )}
                >
                  <div
                    className={cn(
                      "text-[12.5px] font-medium",
                      state.kind === "REVOKED" ? "text-neg" : "text-warn",
                    )}
                  >
                    {described?.headline}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
                    {described?.detail}
                  </p>
                  <button
                    type="button"
                    onClick={refresh}
                    className="mt-2 text-[11.5px] font-medium text-ai underline"
                  >
                    Check again
                  </button>
                </div>
              )}
            </PanelBody>
          </Panel>
        </div>

        {/* --- PERMISSIONS -------------------------------------------------- */}
        <Panel>
          <PanelHeader
            eyebrow="Permissions"
            title="What Chain-Doi declares"
            subtitle="Read from the on-chain membership record."
          />
          <PanelBody className="space-y-3">
            {state?.kind === "AUTHORIZED" ? (
              <>
                <ul className="space-y-2.5">
                  {state.permissions.map((permission) => (
                    <PermissionRow key={permission.permission} status={permission} />
                  ))}
                </ul>

                {/* The boundary, stated once and plainly. */}
                <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    What these are
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
                    Company-policy declarations recorded on chain. They gate what this interface
                    offers. They are <strong className="text-ink">not</strong> Move capabilities:
                    moving money still requires the capability each on-chain function demands,
                    and this identity holds none.
                  </p>
                </div>
              </>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-ink-faint">
                No permissions. Permissions come from an active company membership, and this
                address does not have one.
              </p>
            )}
          </PanelBody>
        </Panel>
      </div>
    </PageContainer>
  );
}

function PermissionRow({ status }: { status: PermissionStatus }) {
  return (
    <li className="rounded-lg border border-hairline bg-surface px-3.5 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className={cn("text-[12px]", status.granted ? "text-pos" : "text-ink-faint")}>
          {status.granted ? "✓" : "·"}
        </span>
        <span
          className={cn(
            "text-[13px] font-medium",
            status.granted ? "text-ink" : "text-ink-faint",
          )}
        >
          {status.label}
        </span>
      </div>
      {status.caveat ? (
        <p className="mt-1 pl-5 text-[11px] leading-relaxed text-warn">{status.caveat}</p>
      ) : null}
    </li>
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
