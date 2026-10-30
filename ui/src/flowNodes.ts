import { useMemo, useRef } from 'react';
import { useStore, useStoreApi, type Edge, type Node } from '@xyflow/react';

/**
 * What keeps the canvases (Areas, Systems, the team graph) quick when they're crowded: React Flow
 * redraws a card or a line whenever it's handed a new object for it, so those that hold the same
 * as before are handed the same object, and far out a card draws less.
 */

/** Whether two values hold the same: equal primitives, the same function, or arrays, Maps, Sets and plain objects holding the same. */
export function same(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || depth > 8) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i], depth + 1));
  if (a instanceof Map) return b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && same(v, b.get(k), depth + 1));
  if (a instanceof Set) return b instanceof Set && a.size === b.size && [...a].every(x => b.has(x));
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1));
}

/**
 * The nodes, each one holding the same as last time kept as the object React Flow already has, so
 * only the cards that changed redraw. A changed card keeps the size React Flow measured, so it
 * isn't hidden and measured again (it's measured anyway if its size changes).
 */
export function useSteadyNodes<N extends Node>(nodes: N[]): N[] {
  const store = useStoreApi();
  // Each node as built, and as handed over.
  const last = useRef(new Map<string, { built: N; given: N }>());
  return useMemo(() => {
    const lookup = store.getState().nodeLookup;
    const next = new Map<string, { built: N; given: N }>();
    const out = nodes.map(n => {
      const o = last.current.get(n.id);
      let given = n;
      if (o && same(o.built, n)) given = o.given;
      else if (!n.measured) {
        const m = lookup.get(n.id)?.measured;
        if (m?.width && m.height) given = { ...n, measured: { width: m.width, height: m.height } };
      }
      next.set(n.id, { built: n, given });
      return given;
    });
    last.current = next;
    return out;
  }, [nodes, store]);
}

/** The edges, each one drawn the same as last time kept as the object React Flow already has, so only the lines that changed redraw. */
export function useSteadyEdges<E extends Edge>(edges: E[]): E[] {
  const last = useRef(new Map<string, E>());
  return useMemo(() => {
    const out = edges.map(e => {
      const o = last.current.get(e.id);
      return o && same(o, e) ? o : e;
    });
    last.current = new Map(out.map(e => [e.id, e]));
    return out;
  }, [edges]);
}

/** Zoomed out past where a card's small print can be read: cards draw only what can. */
export const FAR_ZOOM = 0.45;
export const useFar = () => useStore(s => s.transform[2] < FAR_ZOOM);
