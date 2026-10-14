import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { now } from '@/fixtures/runtime';

const STORAGE_KEY = 'wallet.diagnostics.v1';

/** Work kept in memory to save rebuilding it, which a memory warning gives back. */
export type MemoryCache<V> = { get: (key: string, make: () => V) => V };

const caches = new Map<string, Map<string, unknown>>();

/**
 * A cache that iOS can empty: on a memory warning every entry goes, and the next `get` rebuilds it.
 * Beyond `limit` entries the oldest goes. `name` labels it in the report Diagnostics shares.
 */
export function memoryCache<V>(name: string, { limit = 50 }: { limit?: number } = {}): MemoryCache<V> {
  const entries = new Map<string, V>();
  caches.set(name, entries as Map<string, unknown>);
  return {
    get(key, make) {
      if (!entries.has(key)) {
        entries.set(key, make());
        if (entries.size > limit) entries.delete(entries.keys().next().value!);
      }
      return entries.get(key) as V;
    },
  };
}

/** What each cache holds right now, by name. */
export function cachedEntries(): Array<{ name: string; entries: number }> {
  return [...caches].map(([name, entries]) => ({ name, entries: entries.size })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The last memory warning (kept across launches, for support) and how many arrived since launch. */
type Warnings = { last: number | null; sinceLaunch: number };
let warnings: Warnings = { last: null, sinceLaunch: 0 };
const listeners = new Set<() => void>();
const publish = (next: Warnings) => {
  warnings = next;
  listeners.forEach((listener) => listener());
};

/**
 * Drops every memory cache when iOS warns that memory is low, and records when it happened. Runs for as
 * long as the app does; returns the unsubscribe for the root layout's effect.
 */
export function watchMemoryWarnings(): () => void {
  AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
    const last = raw ? (JSON.parse(raw) as { lastMemoryWarning?: unknown }).lastMemoryWarning : null;
    // A warning that arrived while this was loading is newer.
    if (typeof last === 'number' && warnings.last === null) publish({ ...warnings, last });
  }).catch(() => { /* No record: none shown. */ });
  const subscription = AppState.addEventListener('memoryWarning', () => {
    caches.forEach((entries) => entries.clear());
    const at = now();
    publish({ last: at, sinceLaunch: warnings.sinceLaunch + 1 });
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ lastMemoryWarning: at })).catch(() => { /* Shown until the app ends. */ });
  });
  return () => subscription.remove();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The memory warnings iOS has sent, updated as they arrive. */
export function useMemoryWarnings(): Warnings {
  return useSyncExternalStore(subscribe, () => warnings);
}
