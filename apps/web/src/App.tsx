import { useState } from "react";
import { usePreferences, useDocumentPreferences, useServices, useT } from "./app-context.tsx";
import { AccountView } from "./components/AccountView.tsx";
import { BackupView } from "./components/BackupView.tsx";
import { CalendarView } from "./components/CalendarView.tsx";
import { GoalsView } from "./components/GoalsView.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { InboxView } from "./components/InboxView.tsx";
import { ProjectsView } from "./components/ProjectsView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { ConnectivityNotice, StatusBar } from "./components/StatusBar.tsx";
import { TodayView } from "./components/TodayView.tsx";
import { SessionPrompts, useTrashMaintenance, WorkScreen } from "./components/work-ui.tsx";

type View = "home" | "today" | "work" | "calendar" | "inbox" | "projects" | "goals" | "settings" | "backup" | "account";

export function App() {
  const prefs = usePreferences();
  useDocumentPreferences(prefs);
  const t = useT();
  const { syncEnabled } = useServices();
  const [view, setView] = useState<View>("home");
  useTrashMaintenance();

  const navItems: { id: View; label: string }[] = [
    { id: "home", label: t("nav.home") },
    { id: "today", label: t("nav.today") },
    { id: "work", label: t("nav.work") },
    { id: "calendar", label: t("nav.calendar") },
    { id: "inbox", label: t("nav.inbox") },
    { id: "projects", label: t("nav.projects") },
    { id: "goals", label: t("nav.goals") },
    { id: "settings", label: t("nav.settings") },
    { id: "backup", label: t("nav.backup") },
    // Frozen post-v1 sync screens: only in builds with the flag on (D-016).
    ...(syncEnabled ? [{ id: "account" as const, label: t("nav.account") }] : []),
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
        <SessionPrompts />
        {view === "home" ? (
          <HomeView onOpenBackup={() => setView("backup")} />
        ) : view === "today" ? (
          <TodayView onOpenSettings={() => setView("settings")} onOpenWork={() => setView("work")} />
        ) : view === "work" ? (
          <WorkScreen onOpenSettings={() => setView("settings")} />
        ) : view === "calendar" ? (
          <CalendarView onOpenSettings={() => setView("settings")} />
        ) : view === "inbox" ? (
          <InboxView />
        ) : view === "projects" ? (
          <ProjectsView />
        ) : view === "goals" ? (
          <GoalsView />
        ) : view === "settings" ? (
          <SettingsView />
        ) : view === "backup" ? (
          <BackupView />
        ) : syncEnabled ? (
          <AccountView />
        ) : null}
      </main>
    </div>
  );
}
