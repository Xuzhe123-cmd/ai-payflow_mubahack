"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Mail01Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Panel, PanelBody } from "@/components/common/Panel";
import { Eyebrow } from "@/components/common/Badge";
import { StageList } from "@/components/common/States";
import { CONNECT_STAGES } from "@/lib/services/inboxService";
import { usePayflow } from "@/components/providers/PayflowProvider";

/**
 * Invoice detection, without an inbox clone.
 *
 * The operator connects a mailbox once; from then on invoices arrive as
 * treasury items, not as email. The staged list is the honest version of what
 * the real connector does, so swapping the demo adapter for Gmail changes the
 * timings and nothing else.
 */
export function ConnectInboxCard() {
  const { state, connectInbox } = usePayflow();
  const connecting = state.inboxStatus === "CONNECTING";

  const stages = CONNECT_STAGES.map((stage) => {
    const done = state.completedConnectStages.includes(stage.id);
    const active = state.connectStage === stage.id;
    return {
      id: stage.id,
      label: stage.label,
      state: active && connecting ? ("active" as const) : done ? ("done" as const) : ("pending" as const),
    };
  });

  return (
    <Panel className="overflow-hidden">
      <PanelBody className="px-7 py-8">
        <div className="mx-auto flex max-w-lg flex-col items-center text-center">
          <span className="grid size-11 place-items-center rounded-xl border border-hairline bg-surface-sunken text-ink-soft">
            <HugeiconsIcon icon={Mail01Icon} size={20} strokeWidth={1.7} />
          </span>

          <Eyebrow className="mt-4 block">Finance email</Eyebrow>
          <h2 className="mt-2 text-[19px] font-semibold tracking-[-0.015em] text-ink">
            Connect your finance inbox
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
            AI PayFlow watches a single mailbox for supplier invoices, extracts
            the figures, and brings them into the treasury for analysis. Nothing
            is paid without passing on-chain policy first.
          </p>

          {connecting ? (
            <StageList stages={stages} className="mt-7 w-full max-w-sm text-left" />
          ) : (
            <Button
              size="lg"
              className="mt-6 rounded-xl px-6"
              onClick={() => void connectInbox()}
            >
              Connect finance email
            </Button>
          )}

          {!connecting ? (
            <p className="mt-4 text-[11.5px] text-ink-faint">
              Demo adapter · Gmail and Outlook connectors drop into the same
              interface
            </p>
          ) : null}
        </div>
      </PanelBody>
    </Panel>
  );
}
