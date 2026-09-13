import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import "@/components/ui/ui.css";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} disableHoverableContent>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  label,
  side = "top",
  children,
  focusable = false,
}: {
  label: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
  focusable?: boolean;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        asChild={!focusable}
        type={focusable ? "button" : undefined}
        className={focusable ? "tooltip-trigger" : undefined}
        onFocus={(event) => {
          if (!event.currentTarget.matches(":focus-visible"))
            event.preventDefault();
        }}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className="tooltip"
          side={side}
          sideOffset={6}
          collisionPadding={8}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
