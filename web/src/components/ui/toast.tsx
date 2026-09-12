import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button, IconButton } from "@/components/ui/index";
import "@/components/ui/toast.css";

export type ToastTone = "success" | "danger" | "info";

export type ToastAction = { label: string; onClick: () => void };

export type ToastOptions = {
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  duration?: number | null;
  closable?: boolean;
  id?: string;
};

export type ToastItem = {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  duration: number | null;
  closable: boolean;
  open: boolean;
  revision: number;
};

const DURATIONS: Record<ToastTone, number> = {
  success: 4000,
  info: 4000,
  danger: 8000,
};

const EXIT_MS = 200;

let items: ToastItem[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const removals = new Map<string, ReturnType<typeof setTimeout>>();

function publish(next: ToastItem[]) {
  items = next;
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readToasts(): ToastItem[] {
  return items;
}

export function toast(options: ToastOptions): string {
  const id = options.id ?? `toast-${++sequence}`;
  const pending = removals.get(id);
  if (pending) {
    clearTimeout(pending);
    removals.delete(id);
  }
  const existing = items.find((item) => item.id === id);
  const next: ToastItem = {
    id,
    tone: options.tone,
    title: options.title,
    description: options.description,
    action: options.action,
    duration:
      options.duration === undefined
        ? DURATIONS[options.tone]
        : options.duration,
    closable: options.closable ?? true,
    open: true,
    revision: existing ? existing.revision + 1 : 0,
  };
  publish(
    existing
      ? items.map((item) => (item.id === id ? next : item))
      : [...items, next],
  );
  return id;
}

export function dismissToast(id: string): void {
  const existing = items.find((item) => item.id === id);
  if (!existing?.open) return;
  publish(
    items.map((item) => (item.id === id ? { ...item, open: false } : item)),
  );
  removals.set(
    id,
    setTimeout(() => {
      removals.delete(id);
      publish(items.filter((item) => item.id !== id));
    }, EXIT_MS),
  );
}

export function clearToasts(): void {
  for (const timer of removals.values()) clearTimeout(timer);
  removals.clear();
  publish([]);
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") return <CircleCheck size={16} />;
  if (tone === "danger") return <CircleAlert size={16} />;
  return <Info size={16} />;
}

function ToastView({ item }: { item: ToastItem }) {
  return (
    <ToastPrimitive.Root
      className="toast"
      data-tone={item.tone}
      type={item.tone === "danger" ? "foreground" : "background"}
      duration={item.duration ?? Infinity}
      open={item.open}
      onOpenChange={(open) => {
        if (!open && item.closable) dismissToast(item.id);
      }}
      onSwipeEnd={(event) => {
        if (!item.closable) event.preventDefault();
      }}
    >
      <span className="toast-icon" aria-hidden="true">
        <ToneIcon tone={item.tone} />
      </span>
      <div className="toast-body">
        <ToastPrimitive.Title className="toast-title">
          {item.title}
        </ToastPrimitive.Title>
        {item.description ? (
          <ToastPrimitive.Description className="toast-description">
            {item.description}
          </ToastPrimitive.Description>
        ) : null}
      </div>
      {item.action ? (
        <ToastPrimitive.Action asChild altText={item.action.label}>
          <Button size="sm" onClick={item.action.onClick}>
            {item.action.label}
          </Button>
        </ToastPrimitive.Action>
      ) : null}
      {item.closable ? (
        <ToastPrimitive.Close asChild>
          <IconButton label="Close" size="sm">
            <X size={14} />
          </IconButton>
        </ToastPrimitive.Close>
      ) : null}
    </ToastPrimitive.Root>
  );
}

export function Toaster() {
  const current = useSyncExternalStore(subscribeToasts, readToasts, readToasts);
  return (
    <ToastPrimitive.Provider label="Notification" swipeDirection="right">
      {current.map((item) => (
        <ToastView key={`${item.id}:${item.revision}`} item={item} />
      ))}
      <ToastPrimitive.Viewport
        className="toast-viewport"
        label="Notifications"
      />
    </ToastPrimitive.Provider>
  );
}
