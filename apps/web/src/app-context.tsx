import { DEFAULT_PREFERENCES, type PreferenceFields } from "@pps/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getLastBackupAt } from "./backup/export.ts";
import { FROZEN_SYNC_ENABLED } from "./flags.ts";
import { createTranslator, directionOf, type Translate } from "./i18n/index.ts";
import { LocalDb } from "./local/db.ts";
import { loadEffectivePreferences } from "./local/settings.ts";
import { ApiClient } from "./sync/api-client.ts";
import { SyncEngine, type SyncStatus } from "./sync/sync-engine.ts";

export interface AppServices {
  db: LocalDb;
  api: ApiClient;
  engine: SyncEngine;
  /** False in v1 (D-016): the frozen sync engine is never started and its screens are hidden. */
  syncEnabled: boolean;
}

export function createServices(options: { dbName?: string; apiBaseUrl?: string; syncEnabled?: boolean } = {}): AppServices {
  const db = new LocalDb(options.dbName);
  const api = new ApiClient(options.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? "");
  return { db, api, engine: new SyncEngine(db, api), syncEnabled: options.syncEnabled ?? FROZEN_SYNC_ENABLED };
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  useEffect(() => {
    if (!services.syncEnabled) return;
    services.engine.start().catch((error: unknown) => console.error("Sync engine failed to start", error));
    return () => void services.engine.stop();
  }, [services]);
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("ServicesProvider is missing");
  return services;
}

/** Shared preferences (exported) combined with this device's language and theme (D-017). */
export function usePreferences(): PreferenceFields {
  const { db } = useServices();
  return useLiveQuery(() => loadEffectivePreferences(db), [db]) ?? DEFAULT_PREFERENCES;
}

/** ISO time of the last completed export, or null; undefined while loading. */
export function useLastBackupAt(): string | null | undefined {
  const { db } = useServices();
  return useLiveQuery(() => getLastBackupAt(db), [db]);
}

export function useT(): Translate {
  const { language } = usePreferences();
  return useMemo(() => createTranslator(language), [language]);
}

export function useSyncStatus(): SyncStatus {
  const { engine } = useServices();
  return useSyncExternalStore(engine.subscribe, engine.getStatus, engine.getStatus);
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

const SHELL_HINT_KEY = "pps-shell";

/**
 * Applies language direction and theme to <html>. A copy is kept in localStorage only so the
 * next start can paint in the right theme/direction before IndexedDB loads (public/boot.js).
 */
export function useDocumentPreferences(prefs: PreferenceFields): void {
  useEffect(() => {
    const root = document.documentElement;
    root.lang = prefs.language;
    root.dir = directionOf(prefs.language);
    root.dataset.theme = prefs.theme;
    try {
      localStorage.setItem(SHELL_HINT_KEY, JSON.stringify({ language: prefs.language, theme: prefs.theme }));
    } catch {
      // Storage may be unavailable (private mode); the shell still works.
    }
  }, [prefs.language, prefs.theme]);
}
