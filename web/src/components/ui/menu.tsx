import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import "./menu.css";

export type MenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect: () => void;
};

export function OverflowMenu({
  label,
  actions,
  align = "end",
}: {
  label: string;
  actions: MenuAction[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const buttons = list.current?.querySelectorAll("button");
    buttons?.[active]?.focus();
  }, [open, active]);

  const enabled = actions.filter((action) => !action.disabled);
  if (enabled.length === 0) return null;

  const step = (delta: number) => {
    setActive((current) => {
      const size = actions.length;
      let next = current;
      for (let hop = 0; hop < size; hop += 1) {
        next = (next + delta + size) % size;
        if (!actions[next].disabled) return next;
      }
      return current;
    });
  };

  return (
    <div className="menu" ref={wrapper}>
      <button
        type="button"
        className="menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setActive(actions.findIndex((action) => !action.disabled));
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(actions.findIndex((action) => !action.disabled));
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div
          className="menu-list"
          id={menuId}
          data-align={align}
          ref={list}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              wrapper.current?.querySelector("button")?.focus();
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              step(1);
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              step(-1);
            }
            if (event.key === "Tab") setOpen(false);
          }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className="menu-item"
              data-tone={action.tone ?? "default"}
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                wrapper.current?.querySelector("button")?.focus();
                action.onSelect();
              }}
            >
              {action.icon ? (
                <span className="menu-item-icon" aria-hidden="true">
                  {action.icon}
                </span>
              ) : null}
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
