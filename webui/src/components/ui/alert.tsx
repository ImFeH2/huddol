import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

const alertVariants = cva(
  "relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-lg border px-3.5 py-3 text-fg text-sm has-[>svg]:grid-cols-[16px_minmax(0,1fr)] [&>svg]:h-lh [&>svg]:w-4",
  {
    defaultVariants: { variant: "error" },
    variants: {
      variant: {
        error: "border-danger/32 bg-danger/4 [&>svg]:text-danger",
      },
    },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      className={twMerge(clsx(alertVariants({ variant }), className))}
      data-slot="alert"
      role="alert"
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      className={twMerge(
        "text-sm leading-body font-medium [svg~&]:col-start-2",
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
        "flex flex-col gap-2.5 text-fg-muted [svg~&]:col-start-2",
        className,
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}
