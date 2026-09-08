import { ArrowLeft, ChevronDown } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import "./shell.css";

export function Shell({
  sidebar,
  notice,
  children,
}: {
  sidebar: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      {sidebar}
      <div className="shell-content">
        {notice}
        {children}
      </div>
    </div>
  );
}

export function Sidebar({ children }: { children: ReactNode }) {
  return (
    <div className="sidebar">
      <div className="sidebar-scroll">{children}</div>
    </div>
  );
}

export function SidebarOrg({
  name,
  detail,
  mark,
}: {
  name: string;
  detail: ReactNode;
  mark: ReactNode;
}) {
  return (
    <div className="sidebar-org">
      <span className="sidebar-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="sidebar-org-text">
        <span className="sidebar-org-name">{name}</span>
        <span className="sidebar-org-detail">{detail}</span>
      </span>
    </div>
  );
}

export function Nav({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const container = useRef<HTMLElement>(null);

  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      container.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ) ?? [],
    ).filter((item) => item.offsetParent !== null);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(index + delta + items.length) % items.length].focus();
  };

  return (
    <nav className="nav" aria-label={label} ref={container} onKeyDown={move}>
      {children}
    </nav>
  );
}

export function NavSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section className="nav-section">
      <button
        type="button"
        className="nav-section-header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown className="nav-chevron" size={14} aria-hidden="true" />
        {label}
      </button>
      <div className="nav-section-body" id={bodyId} data-open={open}>
        <ul className="nav-list" hidden={!open}>
          {children}
        </ul>
      </div>
    </section>
  );
}

export function NavItem({
  icon,
  label,
  active,
  badge,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="nav-item"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
      >
        <span className="nav-item-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="nav-item-label">{label}</span>
        {badge}
      </button>
    </li>
  );
}

export function SidebarSecondary({ children }: { children: ReactNode }) {
  return <div className="sidebar-secondary">{children}</div>;
}

export function SidebarLink({
  icon,
  label,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="sidebar-link" onClick={onSelect}>
      <span className="nav-item-icon" aria-hidden="true">
        {icon}
      </span>
      {label}
    </button>
  );
}

export function SidebarFooter({ children }: { children: ReactNode }) {
  return <div className="sidebar-footer">{children}</div>;
}

export function Page({ children }: { children: ReactNode }) {
  return <main className="page">{children}</main>;
}

export function PageHeader({
  title,
  lede,
  actions,
  crumb,
  leading,
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  crumb?: { label: string; onSelect: () => void };
  leading?: ReactNode;
}) {
  return (
    <header className="page-header">
      {crumb ? (
        <button type="button" className="crumb" onClick={crumb.onSelect}>
          <ArrowLeft size={14} aria-hidden="true" />
          {crumb.label}
        </button>
      ) : null}
      <div className="page-header-main">
        {leading}
        <div className="page-heading">
          <h1>{title}</h1>
          {lede ? <p className="page-lede">{lede}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function ToolbarSpacer() {
  return <span className="toolbar-spacer" />;
}

export function PageBody({
  children,
  variant = "scroll",
}: {
  children: ReactNode;
  variant?: "scroll" | "flush";
}) {
  return (
    <div className="page-body" data-variant={variant}>
      {children}
    </div>
  );
}

export type Column = {
  key: string;
  label: string;
  align?: "start" | "end";
  width?: string;
  hideBelow?: "sm" | "md";
};

export function Table({
  columns,
  children,
  label,
}: {
  columns: Column[];
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="table-wrap">
      <table className="table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-align={column.align ?? "start"}
                data-hide-below={column.hideBelow}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label ? (
                  column.label
                ) : (
                  <span className="sr-only">Actions</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function RowLink({
  primary,
  secondary,
  onSelect,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="row-link" onClick={onSelect}>
      <span className="row-primary">{primary}</span>
      {secondary ? <span className="row-secondary">{secondary}</span> : null}
    </button>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <div className="section-heading">
          <h2>{title}</h2>
          {description ? <p className="section-lede">{description}</p> : null}
        </div>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
