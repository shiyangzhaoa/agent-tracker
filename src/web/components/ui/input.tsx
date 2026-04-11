import * as React from "react";

import { cn } from "../../lib/cn";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-8 w-full rounded-[7px] bg-[#1a1a1a] border border-[#252525] px-3 py-1.5 text-[12px] text-[#e8e8e8] outline-none placeholder:text-[#3a3a3a] focus-visible:border-[#363636] transition-colors",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
