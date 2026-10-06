import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
}

interface AsyncOptions {
  pollMs?: number;
  enabled?: boolean;
  /** Compared by identity: a new value re-runs the read and keeps the current data meanwhile. */
  reloadKey?: unknown;
}

/**
 * Runs `fn` when `deps` change (clearing the data first) and on polls, reloads and `reloadKey` changes
 * (keeping the data, so nothing flickers). Results of superseded runs are dropped.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[], opts: AsyncOptions = {}): AsyncState<T> {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: null,
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const previous = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    const current = [...deps, enabled];
    const before = previous.current;
    const changed = before === null || before.length !== current.length || current.some((v, i) => !Object.is(v, before[i]));
    previous.current = current;
    if (!enabled) {
      setState({ data: undefined, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => (changed ? { data: undefined, error: null, loading: true } : { ...s, loading: true }));
    fnRef.current().then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setState((s) => ({ data: changed ? undefined : s.data, error, loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
    // The caller's deps decide when the read starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, tick, opts.reloadKey]);

  useEffect(() => {
    if (!opts.pollMs || !enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** localStorage can be unavailable (private mode, blocked storage); the app works without it. */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the value lasts for this page view only.
  }
}
