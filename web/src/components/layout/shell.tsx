import { ArrowLeft } from "lucide-react";
import { Children, type ReactNode, useRef } from "react";
import "@/components/ui/ui.css";
import "@/components/layout/shell.css";

export function Shell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      {sidebar}
      <div className="shell-content">{children}</div>
    </div>
  );
}

export function Sidebar({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-scroll">{children}</div>
      {footer ? <div className="sidebar-footer">{footer}</div> : null}
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
        ".nav-item:not([disabled]), .nav-subitem:not([disabled])",
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
      <ul className="nav-list">{children}</ul>
    </nav>
  );
}

export function NavItem({
  icon,
  label,
  active,
  badge,
  trailing,
  onSelect,
  children,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: ReactNode;
  trailing?: ReactNode;
  onSelect: () => void;
  children?: ReactNode;
}) {
  const nested = Children.toArray(children);
  return (
    <li>
      <div className="nav-row" data-active={active}>
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
        {trailing ? <span className="nav-trailing">{trailing}</span> : null}
      </div>
      {nested.length > 0 ? <ul className="nav-sublist">{nested}</ul> : null}
    </li>
  );
}

export function NavSubItem({
  label,
  active,
  badge,
  indicator,
  onSelect,
}: {
  label: string;
  active: boolean;
  badge?: ReactNode;
  indicator?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="nav-subitem"
        aria-current={active ? "page" : undefined}
        data-unread={badge ? "true" : undefined}
        onClick={onSelect}
      >
        {indicator ? (
          <span className="nav-subitem-indicator">{indicator}</span>
        ) : null}
        <span className="nav-item-label">{label}</span>
        {badge}
      </button>
    </li>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <main className="page">{children}</main>;
}

export function PageTransition({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="page-transition" key={id}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  status,
  actions,
  crumb,
  leading,
}: {
  title: ReactNode;
  status?: ReactNode;
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
          {status ? <div className="page-status">{status}</div> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
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
                  <span className="visually-hidden">Actions</span>
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
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <div className="section-heading">
          <h2>{title}</h2>
        </div>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
