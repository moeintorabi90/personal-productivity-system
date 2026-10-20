import { useEffect, useState } from "react";

export type OfflineReadiness = "dev" | "unsupported" | "installing" | "ready";

/** Registers the app-shell service worker (production builds only). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error: unknown) => {
      console.warn("Service worker registration failed", error);
    });
  });
  // Ask the browser not to evict local data under storage pressure (granted silently or not at all).
  void navigator.storage?.persist?.().catch(() => undefined);
}

export function useOfflineReadiness(): OfflineReadiness {
  const [state, setState] = useState<OfflineReadiness>(() => {
    if (!import.meta.env.PROD) return "dev";
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
    return navigator.serviceWorker.controller ? "ready" : "installing";
  });
  useEffect(() => {
    if (state !== "installing") return;
    let cancelled = false;
    void navigator.serviceWorker.ready.then(() => {
      if (!cancelled) setState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [state]);
  return state;
}
