import { useState } from "react";
import { usePreferences, useDocumentPreferences, useT } from "./app-context.tsx";
import { AccountView } from "./components/AccountView.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { ConnectivityNotice, StatusBar } from "./components/StatusBar.tsx";

type View = "home" | "settings" | "account";

export function App() {
  const prefs = usePreferences();
  useDocumentPreferences(prefs);
  const t = useT();
  const [view, setView] = useState<View>("home");

  const navItems: { id: View; label: string }[] = [
    { id: "home", label: t("nav.home") },
    { id: "settings", label: t("nav.settings") },
    { id: "account", label: t("nav.account") },
  ];

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t("app.skipToContent")}
      </a>
      <header className="app-header">
        <p className="app-name">{t("app.name")}</p>
        <StatusBar />
      </header>
      <nav className="app-nav" aria-label={t("nav.label")}>
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav-item"
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <main id="main" className="app-main" tabIndex={-1}>
        <ConnectivityNotice />
        {view === "home" ? <HomeView /> : view === "settings" ? <SettingsView /> : <AccountView />}
      </main>
    </div>
  );
}
