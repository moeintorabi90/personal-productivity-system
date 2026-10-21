import { useEffect, useState } from "react";
import { useT } from "../app-context.tsx";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

/** Short install instructions for the target platforms (D-013); iPhone shows no install prompt. */
export function InstallGuide() {
  const t = useT();
  const [installed, setInstalled] = useState(isStandalone);
  useEffect(() => {
    const onInstalled = () => setInstalled(true);
    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, []);

  return (
    <section className="card" aria-labelledby="install-title" data-testid="install-guide">
      <h2 id="install-title">{t("install.title")}</h2>
      {installed ? (
        <p className="notice notice-ok">{t("install.installed")}</p>
      ) : (
        <>
          <p className="muted">{t("install.intro")}</p>
          <ul className="install-list">
            <li>{t("install.windows")}</li>
            <li>{t("install.android")}</li>
            <li>{t("install.iphone")}</li>
          </ul>
        </>
      )}
      <p className="hint">{t("install.dataNote")}</p>
    </section>
  );
}
