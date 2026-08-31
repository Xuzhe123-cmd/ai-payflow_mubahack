/**
 * Small identity marks for the two providers.
 *
 * INLINE SVG, deliberately. The project already draws inline `<svg>` in the
 * chart components, so this adds no dependency, no icon package, and — the part
 * that matters for a page about trust — no runtime network fetch. A logo pulled
 * from a CDN would be one more third party in the render path of a security
 * screen.
 *
 * SIMPLIFIED SHAPES, NOT BRAND ASSETS. A four-point sparkle and a cloud: enough
 * for a reader to tell the two columns apart at a glance, drawn from primitives
 * rather than copied from either vendor's brand kit.
 *
 * The colour is the ONLY thing that distinguishes the providers here. Card
 * background and border stay reserved for the LIVE / DEMO DATA distinction,
 * because that is the claim a reader must not misread — a provider accent that
 * competed with it would make the honest signal harder to see.
 */

import type { ProviderId } from "@/lib/ai/providers";
import { cn } from "@/lib/utils";

/** Provider accent, used on the mark only. */
const ACCENT: Record<ProviderId, string> = {
  gemini: "text-[#4285f4]",
  cloudflare: "text-[#f6821f]",
};

const TINT: Record<ProviderId, string> = {
  gemini: "bg-[#4285f4]/10",
  cloudflare: "bg-[#f6821f]/10",
};

function GeminiGlyph() {
  // A four-point star: two crossed lobes meeting at the centre.
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-3.5">
      <path d="M12 2c.4 4.2 3.4 7.4 7.6 8-4.2.6-7.2 3.8-7.6 8-.4-4.2-3.4-7.4-7.6-8 4.2-.6 7.2-3.8 7.6-8Z" />
    </svg>
  );
}

function CloudflareGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-3.5">
      <path d="M17.3 17H7.2a3.7 3.7 0 0 1-.5-7.4A5 5 0 0 1 16 8.3a3.4 3.4 0 0 1 1.3 8.7Z" />
    </svg>
  );
}

/**
 * The mark, in a tinted rounded square.
 *
 * Small on purpose — a large logo would put the vendor ahead of the finding,
 * and the finding is what the page is for.
 */
export function ProviderMark({
  provider,
  className,
}: {
  provider: ProviderId;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
        TINT[provider],
        ACCENT[provider],
        className,
      )}
    >
      {provider === "gemini" ? <GeminiGlyph /> : <CloudflareGlyph />}
    </span>
  );
}

/** The provider's own accent, for a caller drawing a connector or a rule. */
export function providerAccent(provider: ProviderId): string {
  return ACCENT[provider];
}
