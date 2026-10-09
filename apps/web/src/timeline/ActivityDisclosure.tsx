import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ActivityDisclosureIdentity } from './state';

// Per-pane presentation only; never execution or transcript state.
type Choices = Map<string, boolean>;
type Scope = 'group' | 'item';
const Context = createContext<{
  choices: Choices;
  set: (keys: string[], open: boolean) => void;
  adopt: (identities: ActivityDisclosureIdentity[], scope: Scope) => void;
} | null>(null);
export function ActivityDisclosureProvider({ children }: { children: ReactNode }) {
  const [choices, setChoices] = useState<Choices>(() => new Map());
  const set = useCallback((keys: string[], open: boolean) => setChoices(current => {
    if (keys.every(key => current.get(key) === open)) return current;
    const next = new Map(current);
    for (const key of keys) next.set(key, open);
    return next;
  }), []);
  const adopt = useCallback((identities: ActivityDisclosureIdentity[], scope: Scope) => setChoices(current => {
    let next = current;
    for (const { key, liveKey } of identities) {
      if (!liveKey || !next.has(`${scope}:${liveKey}`)) continue;
      if (next === current) next = new Map(current);
      if (!next.has(`${scope}:${key}`)) next.set(`${scope}:${key}`, next.get(`${scope}:${liveKey}`)!);
      next.delete(`${scope}:${liveKey}`);
    }
    return next;
  }), []);
  const value = useMemo(() => ({ choices, set, adopt }), [choices, set, adopt]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useActivityDisclosure(identities: ActivityDisclosureIdentity[] | undefined, scope: Scope) {
  const context = useContext(Context);
  useEffect(() => { if (identities) context?.adopt(identities, scope); }, [context, identities, scope]);
  if (!identities || !context) return undefined;
  const open = identities.some(({ key, liveKey }) =>
    (context.choices.get(`${scope}:${key}`) ?? (liveKey ? context.choices.get(`${scope}:${liveKey}`) : false)) === true);
  return { open, onToggle: (next: boolean) => {
    if (next !== open) context.set(identities.map(({ key }) => `${scope}:${key}`), next);
  } };
}
