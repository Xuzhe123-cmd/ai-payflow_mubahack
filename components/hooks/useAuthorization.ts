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
}

export interface AuthorizationResult {
  /** Null until the chain has answered. Nothing should render before. */
  state: AuthorizationState | null;
  /**
   * True when no company object exists yet.
   *
   * Distinguished from "not a member" so the interface can say the company has
   * not been created rather than implying this person was refused.
   */
  companyNotDeployed: boolean;
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
  const [answer, setAnswer] = useState<{ address: string; state: AuthorizationState } | null>(
    null,
  );
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
          });
          return;
        }

        if (payload.status === "NOT_DEPLOYED") {
          setNotDeployed(true);
          setAnswer({ address, state: resolveAuthorization({ identity, membership: null }) });
          return;
        }

        setNotDeployed(false);

        if (payload.status === "NO_MEMBERSHIP" || !payload.membership || !payload.company) {
          setAnswer({ address, state: resolveAuthorization({ identity, membership: null }) });
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

        setAnswer({ address, state: resolveAuthorization({ identity, membership }) });
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

  return {
    state,
    companyNotDeployed: identity ? notDeployed : false,
    refresh: () => setAttempt((value) => value + 1),
  };
}
