import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
} from "react";
import { Tooltip } from "@/components/ui/tooltip";
import "@/components/ui/ui.css";

export {
  dismissToast,
  Toaster,
  type ToastOptions,
  type ToastTone,
  toast,
} from "@/components/ui/toast";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = "default",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={className ? `button ${className}` : "button"}
      data-variant={variant}
      data-size={size}
      {...rest}
    />
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: "md" | "sm";
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function IconButton({
  label,
  size = "md",
  pressed,
  type = "button",
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label}>
      <button
        type={type}
        className={className ? `icon-button ${className}` : "icon-button"}
        data-size={size}
        aria-label={label}
        aria-pressed={pressed}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function Input({
  className,
  type,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const base = type === "checkbox" ? "checkbox" : "field";
  return (
    <input
      type={type}
      className={className ? `${base} ${className}` : base}
      {...rest}
    />
  );
}

export function autoGrowHeight(
  scrollHeight: number,
  lineHeight: number,
  padding: number,
  border: number,
  maxRows?: number,
): number {
  const ceiling =
    maxRows && maxRows > 0 ? maxRows * lineHeight + padding : Infinity;
  return Math.min(scrollHeight, ceiling) + border;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export function Textarea({
  className,
  ref,
  autoGrow = false,
  maxRows,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
  autoGrow?: boolean;
  maxRows?: number;
}) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const element = inner.current;
    if (!autoGrow || !element) return;
    const style = getComputedStyle(element);
    const padding =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    const border =
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    element.style.height = "auto";
    element.style.height = `${autoGrowHeight(
      element.scrollHeight,
      Number.parseFloat(style.lineHeight),
      padding,
      border,
      maxRows,
    )}px`;
  });

  return (
    <textarea
      ref={(element) => {
        inner.current = element;
        assignRef(ref, element);
      }}
      className={className ? `field ${className}` : "field"}
      data-auto-grow={autoGrow ? "true" : undefined}
      {...rest}
    />
  );
}

export function SearchField({
  icon,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { icon: ReactNode }) {
  return (
    <div className="search-field">
      <span className="search-field-icon" aria-hidden="true">
        {icon}
      </span>
      <Input type="search" {...rest} />
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="form-hint">{hint}</p> : null}
    </div>
  );
}

export function Badge({
  tone = "default",
  children,
}: {
  tone?: "default" | "unread" | "pending";
  children: ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "blue" | "warning" | "danger" | "success";
  children: ReactNode;
}) {
  return (
    <span className="chip" data-tone={tone}>
      {children}
    </span>
  );
}

export function CountPill({ children }: { children: ReactNode }) {
  return <p className="count-pill">{children}</p>;
}

export function StateDot({
  state,
  ping = false,
}: {
  state: "idle" | "running" | "paused";
  ping?: boolean;
}) {
  const label =
    state === "running" ? "Running" : state === "paused" ? "Paused" : "Idle";
  return (
    <span className="dot-wrap">
      <span className="dot" data-state={state} role="img" aria-label={label} />
      {ping && state === "running" ? (
        <span className="dot-ping" aria-hidden="true" />
      ) : null}
    </span>
  );
}

export function Dot({
  tone,
}: {
  tone: "grey" | "blue" | "green" | "yellow" | "red";
}) {
  return <span className="dot" data-tone={tone} />;
}

export function StatusText({
  dot,
  children,
}: {
  dot: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="status-text">
      {dot}
      {children}
    </span>
  );
}

const HUES = [
  "var(--color-blue-100)",
  "var(--color-green-200)",
  "var(--color-yellow-200)",
  "var(--color-red-100)",
  "var(--color-purple-300)",
];

export function hueFor(name: string): string {
  let total = 0;
  for (let index = 0; index < name.length; index += 1) {
    total = (total * 31 + name.charCodeAt(index)) >>> 0;
  }
  return HUES[total % HUES.length];
}

export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

type AvatarSize = "xs" | "sm" | "md" | "lg";

export function Avatar({
  name,
  size = "md",
}: {
  name: string;
  size?: AvatarSize;
}) {
  return (
    <span
      className="avatar"
      data-size={size}
      style={{ background: hueFor(name) }}
      aria-hidden="true"
    >
      {initialsFor(name)}
    </span>
  );
}

export function AvatarStack({
  names,
  max = 5,
  size = "sm",
}: {
  names: string[];
  max?: number;
  size?: AvatarSize;
}) {
  const shown = names.length > max ? names.slice(0, max) : names;
  const hidden = names.length - shown.length;
  return (
    <span className="avatar-stack" role="img" aria-label={names.join(", ")}>
      {shown.map((name) => (
        <Avatar key={name} name={name} size={size} />
      ))}
      {hidden > 0 ? (
        <span
          className="avatar avatar-more"
          data-size={size}
          aria-hidden="true"
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

export function Meter({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const tone = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "normal";
  return (
    <div className="meter" data-tone={tone}>
      <meter
        className="meter-native"
        aria-label={label}
        value={value}
        min={0}
        max={max}
      />
      <span className="meter-fill" style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function EmptyState({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {action}
    </div>
  );
}
