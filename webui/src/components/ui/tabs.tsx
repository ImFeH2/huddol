import {
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type TabItem<T extends string> = { id: T; label: string };

export function tabIndexAfterKey(
  key: string,
  index: number,
  count: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  disabled = false,
  children,
}: {
  label: string;
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);
  const index = tabs.findIndex((tab) => tab.id === value);

  useLayoutEffect(() => {
    const active =
      list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index];
    if (!active) return;
    const measure = () =>
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(active);
    return () => observer.disconnect();
  }, [index]);

  const focusTab = (at: number) => {
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[at]?.focus();
  };

  return (
    <div className="flex flex-col gap-6">
      <div
        className="relative flex gap-4 border-b border-line"
        role="tablist"
        aria-label={label}
        ref={list}
        onKeyDown={(event) => {
          if (disabled) return;
          const next = tabIndexAfterKey(event.key, index, tabs.length);
          if (next === null) return;
          event.preventDefault();
          onChange(tabs[next].id);
          focusTab(next);
        }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${id}-tab-${tab.id}`}
              className="h-9 py-0 px-[2px] border-0 rounded-xs bg-transparent text-fg-muted text-sm font-medium whitespace-nowrap cursor-pointer transition-[color] duration-(--duration-fast) ease-linear hover:text-fg aria-selected:text-fg"
              aria-selected={selected}
              aria-controls={`${id}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
        {indicator ? (
          <span
            className="absolute left-0 -bottom-px h-[2px] rounded-t-full bg-blue-300 transition-[transform,width] duration-(--duration-base) ease-transform"
            aria-hidden="true"
            style={{
              transform: `translateX(${indicator.left}px)`,
              width: indicator.width,
            }}
          />
        ) : null}
      </div>
      <div
        key={value}
        className="flex flex-col gap-4 animate-rise-in"
        role="tabpanel"
        id={`${id}-panel-${value}`}
        aria-labelledby={`${id}-tab-${value}`}
      >
        {children}
      </div>
    </div>
  );
}
