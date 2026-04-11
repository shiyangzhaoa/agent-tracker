import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[10px] text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40",
  {
    variants: {
      variant: {
        default: "bg-zinc-100 text-zinc-950 hover:bg-white",
        secondary: "bg-[#333333] text-zinc-100 hover:bg-[#3a3a3a]",
        ghost: "bg-transparent text-zinc-400 hover:bg-[#313131] hover:text-zinc-100",
        outline: "bg-[#313131] text-zinc-200 hover:bg-[#3a3a3a]",
      },
      size: {
        default: "h-8 px-3.5 py-2",
        sm: "h-7 px-2.5",
        lg: "h-9 px-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
