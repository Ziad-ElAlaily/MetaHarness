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

let leaving = false;
const onceLeft: (() => void)[] = [];

/**
 * Steps back off an overlay's history entry without going back in place. The page may have moved
 * while it was open (another tab, a file closed), and that went in the overlay's entry, so the
 * address moves down with us; the entry below still says where the page was when it opened.
 */
function leaveEntry(): void {
  const here = location.href;
  leaving = true;
  window.addEventListener(
    'popstate',
    () => {
      // Before the hashchange that follows, so it reads where the page is now.
      history.replaceState(history.state, '', here);
      leaving = false;
      for (const next of onceLeft.splice(0)) next();
    },
    { once: true },
  );
  history.back();
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
    let depth = 0; // Until its entry is in.
    let closed = false;
    let popped = false;
    const pop = () => {
      // Only the top one closes; going back past several closes them in turn.
      if ((Number(history.state?.overlay) || 0) >= depth) return;
      popped = true;
      latest.current();
    };
    const enter = () => {
      if (closed) return;
      depth = (Number(history.state?.overlay) || 0) + 1;
      history.pushState({ overlay: depth }, '', location.href);
      window.addEventListener('popstate', pop);
    };
    // After this tick, so React's strict double run of the effect leaves no entry behind; and after
    // any overlay closing as this one opens, or going back would take this one's entry instead.
    const push = setTimeout(() => (leaving ? onceLeft.push(enter) : enter()));
    return () => {
      closed = true;
      clearTimeout(push);
      window.removeEventListener('popstate', pop);
      if (depth && !popped && Number(history.state?.overlay) === depth) leaveEntry();
    };
  }, [open]);
}
