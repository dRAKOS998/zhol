import { useSyncExternalStore } from 'react';

/** Minimal history router: "/" and "/room/:code". */
const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(path: string, replace = false) {
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => window.location.pathname,
  );
}

export function roomCodeFromPath(path: string): string | null {
  const m = /^\/room\/([A-Za-z0-9]{4,16})\/?$/.exec(path);
  return m ? m[1]!.toUpperCase() : null;
}
