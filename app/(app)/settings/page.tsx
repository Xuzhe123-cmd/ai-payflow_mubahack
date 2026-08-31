"use client";

import { cn } from "@/lib/utils";
import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { Panel, PanelBody, PanelHeader, Field } from "@/components/common/Panel";
import {
  OnChainObjectsPanel,
  TreasuryPolicyPanel,
  useOnChainPolicy,
} from "@/components/settings/PolicyPanels";
import { usePayflow, type DemoSpeed } from "@/components/providers/PayflowProvider";
import { useCurrentAuthorization } from "@/components/hooks/useAuthorization";
import { ROLE_LABEL } from "@/lib/identity/permissions";
import { shortAddress } from "@/lib/services/authService";

const SPEEDS: { id: DemoSpeed; label: string; hint: string }[] = [
  { id: "instant", label: "Instant", hint: "Skip staged delays entirely" },
  { id: "brisk", label: "Brisk", hint: "Halved staging — best on stage" },
  { id: "cinematic", label: "Cinematic", hint: "Full staged timing" },
];

export default function SettingsPage() {
  const policy = useOnChainPolicy();
  const { state, setSpeed } = usePayflow();
  const session = state.session;
  // Company and role are chain-derived, never taken from the session.
  const { state: authorization } = useCurrentAuthorization();

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        subtitle="Treasury policy is enforced on chain and shown here read-only. Interface preferences are local to this session."
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          <TreasuryPolicyPanel policy={policy} />

          <Panel>
            <PanelHeader
              eyebrow="Interface"
              title="Presentation preferences"
              subtitle="Pacing affects staged animations only. Model latency is always real."
            />
            <PanelBody>
              <div className="grid gap-2 sm:grid-cols-3">
                {SPEEDS.map((speed) => (
                  <button
                    key={speed.id}
                    type="button"
                    onClick={() => setSpeed(speed.id)}
                    className={cn(
                      "rounded-xl border px-3.5 py-3 text-left transition-colors",
                      state.speed === speed.id
                        ? "border-ai bg-ai-soft"
                        : "border-hairline hover:bg-surface-sunken",
                    )}
                  >
                    <div
                      className={cn(
                        "text-[13px] font-semibold",
                        state.speed === speed.id ? "text-ai" : "text-ink",
                      )}
                    >
                      {speed.label}
                    </div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">
                      {speed.hint}
                    </div>
                  </button>
                ))}
              </div>
            </PanelBody>
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel>
            <PanelHeader eyebrow="Session" title="Signed-in identity" />
            <PanelBody className="space-y-4">
              {/* Company and role are chain-derived. The session knows who
                  signed in; only the chain knows what they are. */}
              <Field
                label="Company"
                value={
                  authorization?.kind === "AUTHORIZED"
                    ? authorization.membership.companyName
                    : "No on-chain membership"
                }
              />
              <Field
                label="Role"
                value={
                  authorization?.kind === "AUTHORIZED"
                    ? ROLE_LABEL[authorization.membership.role]
                    : "—"
                }
              />
              <Field label="Operator" value={session?.operatorEmail ?? "—"} />
              <Field
                label="Sui address"
                value={session ? shortAddress(session.address, 18, 10) : "—"}
                mono
              />
              <Field label="Authentication" value="zkLogin via Google" />
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                The address is derived from the Google credential. No private key
                is stored by this application.
              </p>
            </PanelBody>
          </Panel>

          <OnChainObjectsPanel policy={policy} />
        </div>
      </div>
    </PageContainer>
  );
}
