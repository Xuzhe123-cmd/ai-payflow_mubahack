"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
  Blockchain01Icon,
  Building03Icon,
  InvoiceIcon,
  Logout03Icon,
  PackageDeliveredIcon,
  Robot01Icon,
  Settings02Icon,
  Shield01Icon,
  UserIcon,
  Time04Icon,
  Wallet02Icon,
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { shortAddress } from "@/lib/services/authService";
import { usePayflow } from "@/components/providers/PayflowProvider";
import { useCurrentAuthorization } from "@/components/hooks/useAuthorization";
import { useInvoiceStats } from "@/components/hooks/usePayflowSelectors";

const PRIMARY_NAV = [
  { href: "/dashboard", label: "Overview", icon: Analytics01Icon },
  { href: "/invoices", label: "Invoices", icon: InvoiceIcon },
  { href: "/treasury", label: "Treasury", icon: Wallet02Icon },
  { href: "/payments", label: "Payments", icon: Blockchain01Icon },
  { href: "/suppliers", label: "Suppliers", icon: Building03Icon },
  { href: "/activity", label: "Activity", icon: Time04Icon },
  { href: "/escrow", label: "Escrow", icon: PackageDeliveredIcon },
];

const SECONDARY_NAV = [
  { href: "/agent", label: "AI Agent", icon: Robot01Icon },
  { href: "/access", label: "On-chain access", icon: UserIcon },
  { href: "/security", label: "Security", icon: Shield01Icon },
  { href: "/settings", label: "Settings", icon: Settings02Icon },
];

export function Sidebar() {
  const pathname = usePathname();
  const { state, signOut } = usePayflow();
  // The company name comes from the on-chain membership record.
  const { state: authorization } = useCurrentAuthorization();
  const session = state.session;

  const pendingCount = state.invoices.filter((invoice) => {
    const run = state.runs[invoice.id];
    return !run || run.status === "DETECTED" || run.status === "ANALYZING";
  }).length;

  // Counted through the shared chain-first rule rather than off `finalOutcome`.
  // A settled invoice makes the guard refuse a SECOND payment, and counting
  // that refusal here put a completed payment in the "needs review" badge.
  const reviewCount = useInvoiceStats().needsReview;

  return (
    <aside
      className={cn(
        "flex h-dvh w-[236px] shrink-0 flex-col border-r border-hairline bg-surface",
        "sticky top-0",
      )}
    >
      <div className="flex h-16 items-center gap-2.5 px-5">
        <Wordmark />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <ul className="space-y-0.5">
          {PRIMARY_NAV.map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
              badge={
                item.href === "/invoices" && pendingCount > 0
                  ? pendingCount
                  : item.href === "/payments" && reviewCount > 0
                    ? reviewCount
                    : null
              }
            />
          ))}
        </ul>

        <div className="my-4 border-t border-hairline" />

        <ul className="space-y-0.5">
          {SECONDARY_NAV.map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={pathname === item.href}
            />
          ))}
        </ul>
      </nav>

      <div className="border-t border-hairline p-3">
        <div className="rounded-lg bg-surface-sunken px-3 py-2.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
            Company
          </div>
          {/* Read from the on-chain company record, never from the session.
              A signed-in user with no membership sees "—", which is the
              truthful answer rather than a company they do not belong to. */}
          <div className="mt-1 truncate text-[13px] font-medium text-ink">
            {authorization?.kind === "AUTHORIZED"
              ? authorization.membership.companyName
              : "—"}
          </div>
          {session ? (
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-pos" />
              <span className="tabular truncate font-mono text-[11px] text-ink-faint">
                {shortAddress(session.address, 8, 6)}
              </span>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={signOut}
          className={cn(
            "mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px]",
            "text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink",
          )}
        >
          <HugeiconsIcon icon={Logout03Icon} size={16} strokeWidth={1.8} />
          Sign out
        </button>
      </div>
    </aside>
  );
}

function NavItem({
  href,
  label,
  icon,
  active,
  badge,
}: {
  href: string;
  label: string;
  icon: typeof Analytics01Icon;
  active: boolean;
  badge?: number | null;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cn(
          "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-colors",
          active
            ? "bg-surface-sunken font-medium text-ink"
            : "text-ink-soft hover:bg-surface-sunken/70 hover:text-ink",
        )}
      >
        <HugeiconsIcon
          icon={icon}
          size={17}
          strokeWidth={active ? 2 : 1.7}
          className={cn(active ? "text-ai" : "text-ink-faint group-hover:text-ink-soft")}
        />
        <span className="flex-1 truncate">{label}</span>
        {badge ? (
          <span className="tabular rounded-full bg-ai px-1.5 py-px text-[10.5px] font-semibold text-white">
            {badge}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="grid size-7 place-items-center rounded-md bg-ink">
        <span className="block size-2.5 rounded-[3px] bg-surface" />
      </span>
      <span className="text-[13.5px] font-semibold tracking-[0.14em] text-ink">
        AI PAYFLOW
      </span>
    </div>
  );
}
