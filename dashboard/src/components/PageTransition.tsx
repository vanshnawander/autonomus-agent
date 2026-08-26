import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

/** Wraps page content with a fade+slide transition on route change. */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [key, setKey] = useState(location.pathname);

  useEffect(() => {
    setKey(location.pathname);
  }, [location.pathname]);

  return (
    <div key={key} className="fade-in">
      {children}
    </div>
  );
}
