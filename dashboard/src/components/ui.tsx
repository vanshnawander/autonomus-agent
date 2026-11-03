import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cliLabel, RUN_STATUS_LABEL, RUN_STATUS_TONE, type Tone } from "@/lib/format";
import type { IconName } from "@/lib/events";
import type { RunStatus } from "@/lib/types";

// ---------------------------------------------------------------- icons

type AnyIcon = IconName | "search" | "plus" | "menu" | "close" | "chevron" | "external" | "keyboard";

const PATHS: Record<AnyIcon, ReactNode> = {
  check: <path d="M3.5 8.5l3 3 6-7" />,
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  alert: (
    <>
      <path d="M8 2.5l6 11H2z" />
      <path d="M8 6.5v3M8 11.5v.01" />
    </>
  ),
  play: <path d="M5 3.5v9l7-4.5z" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  retry: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M12 2v3h-3" />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3M8 11.6v.01" />
    </>
  ),
  send: <path d="M2.5 8l11-5-4 11-2-4.5z" />,
  bot: (
    <>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01" />
    </>
  ),
  flag: <path d="M4 14V2.5M4 3h8l-1.5 3L12 9H4" />,
  terminal: (
    <>
      <path d="M3.5 5l3 3-3 3M8 11.5h4.5" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="2" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  external: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />,
  keyboard: (
    <>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4.5 10h7" />
    </>
  ),
};

export function Icon({ name, className = "" }: { name: AnyIcon; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`icon ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------- chips

export function Chip({
  tone = "muted",
  children,
  title,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span className={`chip tone-${tone}`} title={title}>
      {dot && <span className="chip-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: RunStatus }) {
  return (
    <Chip tone={RUN_STATUS_TONE[status]} dot>
      {RUN_STATUS_LABEL[status]}
      {status === "stopped" && <span className="chip-note"> · resumable</span>}
    </Chip>
  );
}

export function CliBadge({ cli }: { cli?: string | null }) {
  return (
    <span className="cli-badge" title={`Agent CLI: ${cliLabel(cli)}`}>
      {cliLabel(cli)}
    </span>
  );
}

// ---------------------------------------------------------------- layout

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="breadcrumb-item">
          {it.to ? <Link to={it.to}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
          {i < items.length - 1 && <Icon name="chevron" className="breadcrumb-sep" />}
        </span>
      ))}
    </nav>
  );
}

export function Panel({
  title,
  subtitle,
  right,
  children,
  id,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`} id={id}>
      {(title || right) && (
        <header className="panel-head">
          <div className="panel-titles">
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {right && <div className="panel-right">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      {label ?? "Loading…"}
    </div>
  );
}

export function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="notice tone-bad" role="alert">
      <Icon name="alert" />
      <div>{msg}</div>
    </div>
  );
}

export function Notice({
  tone = "info",
  icon = "alert",
  title,
  children,
  action,
}: {
  tone?: Tone;
  icon?: AnyIcon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice tone-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon name={icon} />
      <div className="notice-body">
        {title && <strong>{title}</strong>}
        {children && <div className="notice-text">{children}</div>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}
