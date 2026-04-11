import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-[4px] px-[7px] py-[2px] text-[10px] font-medium leading-[1.4]",
  {
    variants: {
      variant: {
        default: "bg-[#1e1e1e] text-[#9a9a9a]",
        ok: "bg-[#0c1e1a] text-[#00b894]",
        warn: "bg-[#1e1608] text-[#d98f00]",
        fail: "bg-[#280c0e] text-[#e85c5c]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
  VariantProps<typeof badgeVariants> { }

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
