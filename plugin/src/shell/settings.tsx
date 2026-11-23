/*
 * Per-browser preferences: Kubernetes details on or off, inventory width,
 * expanded folders, the library namespace. Kept in localStorage.
 */

import React from 'react';

export interface Settings {
  /** Show Kubernetes names, YAML and objects next to the virtualizer view. */
  k8s: boolean;
  treeWidth: number;
  treeHidden: boolean;
  collapsed: string[];
  /** Namespace holding the shared image library. */
  libraryNamespace: string;
  tasksOpen: boolean;
}

const DEFAULTS: Settings = {
  k8s: false,
  treeWidth: 272,
  treeHidden: false,
  collapsed: [],
  libraryNamespace: 'hangar-library',
  tasksOpen: false,
};

const KEY = 'hangar.settings';

function load(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const Ctx = React.createContext<[Settings, (p: Partial<Settings>) => void]>([DEFAULTS, () => undefined]);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = React.useState<Settings>(load);
  const update = React.useCallback((p: Partial<Settings>) => {
    setS(prev => {
      const next = { ...prev, ...p };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: keep in memory */
      }
      return next;
    });
  }, []);
  const value = React.useMemo(() => [s, update] as [Settings, (p: Partial<Settings>) => void], [s, update]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings() {
  return React.useContext(Ctx);
}

/** True when Kubernetes details are on. */
export function useK8s(): boolean {
  return useSettings()[0].k8s;
}
