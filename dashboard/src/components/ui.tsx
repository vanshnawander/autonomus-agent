import { Link } from "react-router-dom";

export function Breadcrumbs({
  items,
}: {
  items: { label: string; to?: string }[];
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted font-mono mb-3">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {it.to ? (
            <Link to={it.to} className="text-accent hover:underline">
              {it.label}
            </Link>
          ) : (
            <span className="text-fg">{it.label}</span>
          )}
          {i < items.length - 1 && <span className="text-faint">/</span>}
        </span>
      ))}
    </div>
  );
}

export function Card({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`card-elevated rounded-xl overflow-hidden flex flex-col ${className}`}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line-soft">
        <span className="font-semibold text-sm">{title}</span>
        <span className="ml-auto">{right}</span>
      </div>
      <div className="p-3.5">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted text-xs p-4 text-center">{children}</div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 text-muted text-sm p-4">
      <span className="inline-block w-4 h-4 border-2 border-line border-t-accent rounded-full" />
      {label ?? "Loading…"}
    </div>
  );
}

export function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="text-danger text-xs p-4 bg-danger/10 border border-danger/30 rounded-lg">
      {msg}
    </div>
  );
}
