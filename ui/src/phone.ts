import { useEffect, useRef, useSyncExternalStore } from 'react';

/** Narrow, or a phone on its side. Keep the "Phones" block in styles.css on the same query. */
export const PHONE = '(max-width: 720px), (pointer: coarse) and (max-height: 500px)';

export const isPhone = () => matchMedia(PHONE).matches;

const subscribe = (on: () => void) => {
  const m = matchMedia(PHONE);
  m.addEventListener('change', on);
  return () => m.removeEventListener('change', on);
};

/** On a phone the page shows one pane at a time: what would sit side by side takes turns. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone);
}

/**
 * On a phone, the back gesture closes what's open over the page instead of leaving the page. It
 * takes a history entry of its own while open, and gives it back on closing; going somewhere else
 * from inside leaves that entry behind, since the new place is on top of it by then.
 */
export function useBackCloses(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || !isPhone()) return;
    const depth = (Number(history.state?.overlay) || 0) + 1;
    let popped = false;
    const pop = () => {
      // Only the top one closes; going back past several closes them in turn.
      if ((Number(history.state?.overlay) || 0) >= depth) return;
      popped = true;
      latest.current();
    };
    // After this tick, so React's strict double run of the effect leaves no entry behind.
    const push = setTimeout(() => {
      history.pushState({ overlay: depth }, '', location.href);
      window.addEventListener('popstate', pop);
    });
    return () => {
      clearTimeout(push);
      window.removeEventListener('popstate', pop);
      if (!popped && Number(history.state?.overlay) === depth) history.back();
    };
  }, [open]);
}
