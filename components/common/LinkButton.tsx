import Link from "next/link";
import type { ComponentProps } from "react";
import type { VariantProps } from "class-variance-authority";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A link that looks like a button. Kept separate from <Button> so navigation
 * stays an anchor — middle-click and open-in-new-tab keep working, which
 * matters when someone is demoing and wants two screens side by side.
 */
export function LinkButton({
  className,
  variant = "default",
  size = "default",
  ...props
}: ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) {
  return (
    <Link className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}
