import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

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
        {...(focusable
          ? {
              type: "button" as const,
              className:
                "inline-flex items-center p-0 border-0 rounded-xs bg-transparent text-inherit [font:inherit] cursor-help",
            }
          : {})}
        onFocus={(event) => {
          if (!event.currentTarget.matches(":focus-visible"))
            event.preventDefault();
        }}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className="z-(--layer-tooltip) max-w-70 py-1 px-2 rounded-sm bg-surface-raised text-fg text-xs font-medium leading-4 whitespace-pre-line shadow-tooltip origin-(--radix-tooltip-content-transform-origin) animate-pop-in select-none"
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
