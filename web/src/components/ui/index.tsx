import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import "./ui.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
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
};

export function IconButton({
  label,
  size = "md",
  type = "button",
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={className ? `icon-button ${className}` : "icon-button"}
      data-size={size}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Input({
  className,
  type,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  const base = type === "checkbox" ? "checkbox" : "field";
  return (
    <input
      type={type}
      className={className ? `${base} ${className}` : base}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={ref}
      className={className ? `field ${className}` : "field"}
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
  "var(--blue-100)",
  "var(--green-200)",
  "var(--yellow-200)",
  "var(--red-100)",
  "var(--purple-300)",
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

export function Avatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return (
    <span
      className="avatar"
      data-size={size}
      style={{ background: `rgb(${hueFor(name)})` }}
      aria-hidden="true"
    >
      {initialsFor(name)}
    </span>
  );
}

export function Banner({
  tone = "info",
  icon,
  children,
  onDismiss,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  icon?: ReactNode;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="banner" data-tone={tone} role="status">
      {icon ? (
        <span className="banner-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="banner-body">{children}</div>
      {onDismiss ? (
        <button type="button" className="banner-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
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
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}
