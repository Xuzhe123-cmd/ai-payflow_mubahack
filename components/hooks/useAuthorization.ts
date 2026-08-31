"use client";

/**
 * The signed-in person's authorization, resolved from chain.
 *
 * One hook, one answer, used by every surface that needs to know what this
 * human may be offered. It refuses to guess: while the chain read is in
 * flight the state is `null`, and callers render nothing authorization-shaped
 * rather than assuming either direction.
 *
 * The identity comes from the session; the MEMBERSHIP comes from the chain, on
 * every mount. That split is the whole design — a session can be restored from
 * this browser's storage, and a membership cannot, because only the chain
 * knows whether it still exists.
 */

import { useEffect, useMemo, useState } from "react";

import {
  membershipFromChain,
  resolveAuthorization,
  type AuthenticatedIdentity,
  type AuthorizationState,
} from "@/lib/identity/authorization";
import { identityFromSession } from "@/lib/services/authService";
import { usePayflow } from "@/components/providers/PayflowProvider";
import { hasPermission } from "@/lib/identity/permissions";
import {
  MEMBERSHIP_SYNC_MAX_AGE_MS,
  resolvePaymentAuthority,
  type ApproverAuthorization,
  type PaymentAuthorityState,
} from "@/lib/identity/paymentAuthority";

interface IdentityResponse {
  ok?: boolean;
  status?: "NOT_DEPLOYED" | "NO_MEMBERSHIP" | "OK";
  message?: string;
  company?: {
    companyId: string;
    companyName: string;
    treasuryId: string;
    admin: string | null;
    memberCount: number;
  };
  membership?: {
    memberAddress: string;
    roleCode: number;
    permissionMask: number;
    active: boolean;
    grantedAtMs: number;
  };
  /** The treasury's own approver record. Null when it holds none. */
  authorization?: ApproverAuthorization | null;
}

export interface AuthorizationResult {
  /** Null until the chain has answered. Nothing should render before. */
  state: AuthorizationState | null;
  /**
   * Whether Move would accept a payment approval from this address.
   *
   * A SEPARATE question from `state`, deliberately. Membership, role and a
   * declared permission are company facts; this is the treasury's own record,
   * and it is the only one `approval::approve_scoped` reads.
   */
  paymentAuthority: PaymentAuthorityState | null;
  /**
   * True when no company object exists yet.
   *
   * Distinguished from "not a member" so the interface can say the company has
   * not been created rather than implying this person was refused.
   */
  companyNotDeployed: boolean;
  /** When the chain answered, or null before it has. */
  readAtMs: number | null;
  refresh: () => void;
}

/**
 * The signed-in person's authorization, for a caller that has no identity to
 * hand — which is every screen, because the session lives in the provider.
 */
export function useCurrentAuthorization(): AuthorizationResult {
  const { state } = usePayflow();
  const session = state.session;
  // Rebuilt only when the session actually changes; a new object each render
  // would restart the chain read on every paint.
  const identity = useMemo(
    () => (session ? identityFromSession(session) : null),
    [session],
  );
  return useAuthorization(identity);
}

export function useAuthorization(identity: AuthenticatedIdentity | null): AuthorizationResult {
  // Stored WITH the address it describes. A result for a previous identity is
  // not a result for this one, and keying it here means a change of identity
  // reads as "not answered yet" without an effect having to reset anything.
  const [answer, setAnswer] = useState<{
    address: string;
    state: AuthorizationState;
    authorization: ApproverAuthorization | null;
    /**
     * When the chain answered.
     *
     * Captured in the fetch callback rather than read during render: `Date.now()`
     * in a render body makes the render impure, and it is also the wrong clock —
     * expiry should be judged against the moment the authorization was read, not
     * against whenever React happened to re-render.
     */
    readAtMs: number;
  } | null>(null);
  const [notDeployed, setNotDeployed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Nothing to ask the chain about. The unauthenticated answer is derived
    // below rather than written here, so this effect performs no synchronous
    // state update at all.
    if (!identity) return;

    let cancelled = false;
    const address = identity.sui.address;

    void fetch(`/api/identity?address=${encodeURIComponent(identity.sui.address)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as IdentityResponse;
        if (cancelled) return;

        if (!payload.ok) {
          // A failed read is not "no membership". Reported as unknown, and no
          // action is offered while it is.
          setNotDeployed(false);
          setAnswer({
            address,
            state: resolveAuthorization({
              identity,
              chainError: payload.message ?? "The chain could not be read.",
            }),
            authorization: null,
            readAtMs: Date.now(),
          });
          return;
        }

        if (payload.status === "NOT_DEPLOYED") {
          setNotDeployed(true);
          setAnswer({
            address,
            state: resolveAuthorization({ identity, membership: null }),
            authorization: null,
            readAtMs: Date.now(),
          });
          return;
        }

        setNotDeployed(false);

        if (payload.status === "NO_MEMBERSHIP" || !payload.membership || !payload.company) {
          setAnswer({
            address,
            state: resolveAuthorization({ identity, membership: null }),
            authorization: payload.authorization ?? null,
            readAtMs: Date.now(),
          });
          return;
        }

        const membership = membershipFromChain({
          companyId: payload.company.companyId,
          companyName: payload.company.companyName,
          treasuryId: payload.company.treasuryId,
          memberAddress: payload.membership.memberAddress,
          roleCode: payload.membership.roleCode,
          permissionMask: payload.membership.permissionMask,
          active: payload.membership.active,
          grantedAtMs: payload.membership.grantedAtMs,
        });

        setAnswer({
          address,
          state: resolveAuthorization({ identity, membership }),
          authorization: payload.authorization ?? null,
          readAtMs: Date.now(),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setNotDeployed(false);
        setAnswer({
          address,
          state: resolveAuthorization({
            identity,
            chainError:
              error instanceof Error ? error.message : "The chain could not be reached.",
          }),
          authorization: null,
          readAtMs: Date.now(),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [identity, attempt]);

  // Derived, not stored: no identity means unauthenticated, and an answer that
  // belongs to a different address counts as no answer yet.
  const state: AuthorizationState | null = !identity
    ? { kind: "UNAUTHENTICATED" }
    : answer && answer.address === identity.sui.address
      ? answer.state
      : null;

  // The payment-authority question, derived from the SAME chain read. One
  // fetch, two answers — a second lookup could disagree with the first.
  const paymentAuthority: PaymentAuthorityState | null =
    state === null
      ? null
      : resolvePaymentAuthority({
          authenticated: state.kind !== "UNAUTHENTICATED",
          companyExists: !notDeployed,
          isMember: state.kind === "AUTHORIZED" || state.kind === "REVOKED",
          membershipActive: state.kind === "AUTHORIZED",
          role: state.kind === "AUTHORIZED" ? state.membership.role : null,
          declaresApprovePayments:
            state.kind === "AUTHORIZED" &&
            hasPermission(state.membership.permissionMask, "APPROVE_PAYMENTS"),
          authorization: answer?.authorization ?? null,
          // The clock the chain was read at, so expiry is judged
          // against that moment rather than against this render.
          nowMs: answer?.readAtMs ?? 0,
          membershipSyncMaxAgeMs: MEMBERSHIP_SYNC_MAX_AGE_MS,
          chainError: state.kind === "CHAIN_UNAVAILABLE" ? state.reason : null,
        });

  return {
    state,
    paymentAuthority,
    // Shared so a screen previewing one payment uses the same instant the
    // authority was resolved at.
    readAtMs: answer?.readAtMs ?? null,
    companyNotDeployed: identity ? notDeployed : false,
    refresh: () => setAttempt((value) => value + 1),
  };
}
