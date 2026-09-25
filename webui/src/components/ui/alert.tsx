import { clsx } from "clsx";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

export function Alert({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={twMerge(
        clsx(
          "grid min-w-0 grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-lg border border-danger/32 bg-danger/4 px-3.5 py-3 text-sm text-fg",
          className,
        ),
      )}
      data-slot="alert"
      role="alert"
      {...props}
    >
      {children}
    </div>
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      className={twMerge(
        "col-start-2 min-w-0 text-sm font-medium leading-body",
        className,
      )}
      data-slot="alert-title"
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={twMerge(
        "col-start-2 flex min-w-0 flex-col gap-2.5 text-fg-muted",
        className,
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}
