import type { ReactNode } from "react";
import { useEffect, useState } from "react";

/**
 * Tiny hash router. Every record has an address like #/companies/12 or #/tickets/55, so a link can be
 * shared, bookmarked and reached from any other screen, and the browser's Back button works.
 */
export interface Route {
  page: string;
  id: number | null;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const [page = "", id] = path.split("/");
  const n = id ? Number(id) : Number.NaN;
  return { page, id: Number.isInteger(n) && n > 0 ? n : null, params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const navigate = (to: string) => {
  window.location.hash = to.startsWith("/") ? to : `/${to}`;
};

export function Link({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a className="link" href={`#${to.startsWith("/") ? to : `/${to}`}`}>
      {children}
    </a>
  );
}
