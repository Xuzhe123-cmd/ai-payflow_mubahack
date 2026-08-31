/**
 * Roles, permissions, and the distinction this file exists to keep honest.
 *
 * THE CLAIM THAT MUST NOT BE MADE. A permission in a company record and a
 * capability Move actually checks are two different things, and only one of
 * them can stop a payment. `APPROVE_PAYMENTS` on a membership record says the
 * company considers this person an authorized approver. It does not mean the
 * chain will accept their approval — that requires an `ApproverCap`, which
 * `approval::approve` demands and which this identity does not hold.
 *
 *   COMPANY_POLICY     a declaration on the company record. Gates the UI.
 *   MOVE_CAPABILITY    an object Move requires. Gates the money.
 *
 * Every permission in this phase is COMPANY_POLICY. None is capability-backed,
 * and the interface says so rather than letting a green tick imply otherwise.
 * A later phase will rework `approval.move` along the AgentCap pattern — where
 * authority lives in admin-controlled treasury state and is therefore
 * revocable — at which point APPROVE_PAYMENTS can become MOVE_CAPABILITY.
 *
 * THE OTHER HALF OF THE HONESTY. Because no capability is issued, revoking a
 * membership revokes a declaration and nothing else. Nothing in this phase can
 * withdraw payment authority, because none was granted. Said plainly here so
 * no screen has to imply otherwise.
 *
 * The bitmask values mirror `payflow::identity` exactly. They are the wire
 * format between the Move object and this module, so they may not drift.
 */

export type Role = "ADMIN" | "TREASURY_MANAGER" | "APPROVER" | "VIEWER";

export type Permission =
  | "VIEW_INVOICES"
  | "VIEW_TREASURY"
  | "APPROVE_PAYMENTS"
  | "AUTHORIZE_AGENT";

/** Mirrors the `u8` role codes in `payflow::identity`. */
export const ROLE_CODE: Record<Role, number> = {
  ADMIN: 1,
  TREASURY_MANAGER: 2,
  APPROVER: 3,
  VIEWER: 4,
};

/** Mirrors the `u16` permission bits in `payflow::identity`. */
export const PERMISSION_BIT: Record<Permission, number> = {
  VIEW_INVOICES: 1,
  VIEW_TREASURY: 2,
  APPROVE_PAYMENTS: 4,
  AUTHORIZE_AGENT: 8,
};

export const ALL_PERMISSIONS: readonly Permission[] = [
  "VIEW_INVOICES",
  "VIEW_TREASURY",
  "APPROVE_PAYMENTS",
  "AUTHORIZE_AGENT",
];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  TREASURY_MANAGER: "Treasury Manager",
  APPROVER: "Approver",
  VIEWER: "Viewer",
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  VIEW_INVOICES: "View invoices",
  VIEW_TREASURY: "View treasury",
  APPROVE_PAYMENTS: "Approve payments",
  AUTHORIZE_AGENT: "Authorize agent",
};

/**
 * What actually stands behind a permission.
 *
 * Never inferred from the permission being granted — a granted permission with
 * nothing enforcing it is exactly the situation this type exists to describe.
 */
export type EnforcementKind =
  /** Declared on the company record. Gates the interface, not the money. */
  | "COMPANY_POLICY"
  /** Backed by an object Move requires before it will act. */
  | "MOVE_CAPABILITY";

export interface PermissionStatus {
  permission: Permission;
  label: string;
  granted: boolean;
  enforcement: EnforcementKind;
  /**
   * What a reader would otherwise wrongly assume. Present wherever the
   * permission could be mistaken for an authority it does not carry.
   */
  caveat: string | null;
}

/**
 * The permissions a role carries by default.
 *
 * A DEFAULT, not a grant. The authoritative permission set is the bitmask on
 * the on-chain membership record; this only says what the company would
 * normally give such a role, and is used when composing a grant transaction.
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: ["VIEW_INVOICES", "VIEW_TREASURY", "APPROVE_PAYMENTS", "AUTHORIZE_AGENT"],
  TREASURY_MANAGER: ["VIEW_INVOICES", "VIEW_TREASURY", "APPROVE_PAYMENTS", "AUTHORIZE_AGENT"],
  APPROVER: ["VIEW_INVOICES", "VIEW_TREASURY", "APPROVE_PAYMENTS"],
  VIEWER: ["VIEW_INVOICES", "VIEW_TREASURY"],
};

/**
 * The caveat each permission carries in THIS phase.
 *
 * `APPROVE_PAYMENTS` is the one that matters, and it is stated in full rather
 * than softened: no capability was issued, so the chain would refuse an
 * approval from this identity today. Saying less would let a tick imply
 * authority over $88,200 of treasury funds that does not exist.
 */
const CAVEAT: Partial<Record<Permission, string>> = {
  APPROVE_PAYMENTS:
    "Company policy permission — not yet capability-backed. Approving a payment on chain " +
    "requires an ApproverCap, which this identity does not hold.",
  AUTHORIZE_AGENT:
    "Company policy permission. Registering or re-limiting an agent on chain requires the " +
    "TreasuryOwnerCap, which this identity does not hold.",
};

export function permissionsFromMask(mask: number): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => (mask & PERMISSION_BIT[permission]) !== 0);
}

export function maskFromPermissions(permissions: readonly Permission[]): number {
  return permissions.reduce((mask, permission) => mask | PERMISSION_BIT[permission], 0);
}

export function hasPermission(mask: number, permission: Permission): boolean {
  return (mask & PERMISSION_BIT[permission]) !== 0;
}

export function roleFromCode(code: number): Role | null {
  const entry = Object.entries(ROLE_CODE).find(([, value]) => value === code);
  return entry ? (entry[0] as Role) : null;
}

/**
 * Every permission, with what stands behind it.
 *
 * Returns the full set rather than only the granted ones, because "you do not
 * have this" is information a reader wants as much as "you do".
 */
export function describePermissions(mask: number): PermissionStatus[] {
  return ALL_PERMISSIONS.map((permission) => ({
    permission,
    label: PERMISSION_LABEL[permission],
    granted: hasPermission(mask, permission),
    // Nothing in this phase is capability-backed. When that changes it will
    // change here, once, rather than in each screen that renders a tick.
    enforcement: "COMPANY_POLICY" as const,
    caveat: hasPermission(mask, permission) ? (CAVEAT[permission] ?? null) : null,
  }));
}

/**
 * Whether a permission is enforced by Move for this identity.
 *
 * Always false in this phase, and a function rather than a constant so the
 * call sites already ask the right question. A screen that wants to say
 * "on-chain payment authority" has to get `true` from here first, and it
 * cannot.
 */
export function isCapabilityBacked(_permission: Permission): boolean {
  return false;
}
