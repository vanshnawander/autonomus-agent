import { useEffect, useRef } from "react";

/** Auto-scrolling dark terminal pane. */
export function Terminal({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <div className={`terminal-window ${className}`}>
      <div className="terminal-titlebar">
        <span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span>
        <span>agent shell</span>
        <span className="terminal-secure">PTY</span>
      </div>
      <pre ref={ref} className="terminal-screen">
        {text || "Last login: awaiting agent process\n$ _"}
      </pre>
    </div>
  );
}
