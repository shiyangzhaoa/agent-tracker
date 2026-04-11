import * as React from "react";

import { cn } from "../../lib/cn";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number | null;
  indicatorClassName?: string;
}

function Progress({ className, value, indicatorClassName, ...props }: ProgressProps) {
  const safeValue = typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;

  return (
    <div className={cn("relative h-[3px] w-full overflow-hidden rounded-[999px] bg-[#1e1e1e]", className)} {...props}>
      <div
        className={cn("h-full rounded-[999px] bg-[#9a9a9a] transition-[width] duration-500", indicatorClassName)}
        style={{ width: `${safeValue}%` }}
      />
    </div>
  );
}

export { Progress };
