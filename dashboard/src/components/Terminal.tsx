import { useEffect, useRef } from "react";

/** Read-only terminal pane for recorded output. Text should already be ANSI-stripped. */
export function Terminal({
  text,
  title = "terminal",
  className = "",
  autoScroll = true,
}: {
  text: string;
  title?: string;
  className?: string;
  autoScroll?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, autoScroll]);
  return (
    <div className={`term ${className}`}>
      <div className="term-bar">
        <span>{title}</span>
      </div>
      <pre ref={ref} className="term-screen" tabIndex={0} aria-label={title}>
        {text || <span className="muted">Nothing recorded.</span>}
      </pre>
    </div>
  );
}
