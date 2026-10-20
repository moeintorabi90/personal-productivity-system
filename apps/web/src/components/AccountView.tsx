import { PASSWORD_MIN_LENGTH } from "@pps/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useOnline, useServices, useSyncStatus, useT } from "../app-context.tsx";
import type { MessageKey } from "../i18n/index.ts";
import { getMeta } from "../local/db.ts";
import type { DeviceIdentity, StoredSession } from "../local/db.ts";
import { createOwnerAccount, signIn, signOut } from "../sync/account.ts";
import { ApiRequestError, NetworkError } from "../sync/api-client.ts";

function errorKey(error: unknown): MessageKey {
  if (error instanceof NetworkError) return "error.NETWORK";
  if (error instanceof ApiRequestError) {
    const key = `error.${error.code}`;
    const known: MessageKey[] = [
      "error.VALIDATION_FAILED",
      "error.INVALID_CREDENTIALS",
      "error.SETUP_ALREADY_COMPLETED",
      "error.SETUP_TOKEN_INVALID",
      "error.RATE_LIMITED",
      "error.UNAUTHENTICATED",
    ];
    if ((known as string[]).includes(key)) return key as MessageKey;
  }
  return "error.generic";
}

export function AccountView() {
  const t = useT();
  const { db } = useServices();
  // Wrapped in an object so `undefined` means "still loading", not "signed out".
  const result = useLiveQuery(async () => ({ session: await getMeta<StoredSession>(db, "session") }), [db]);

  return (
    <section className="card" aria-labelledby="account-title">
      <h1 id="account-title">{t("account.title")}</h1>
      <p>{t("account.intro")}</p>
      <p className="notice notice-warn">{t("account.devNotice")}</p>
      {!result ? null : result.session ? <SignedIn session={result.session} /> : <SignedOut />}
    </section>
  );
}

function SignedIn({ session }: { session: StoredSession }) {
  const t = useT();
  const { db, api, engine } = useServices();
  const status = useSyncStatus();
  const device = useLiveQuery(() => getMeta<DeviceIdentity>(db, "device"), [db]);
  const [busy, setBusy] = useState(false);

  return (
    <div className="stack">
      <p>{t("account.signedInAs", { email: session.email })}</p>
      {device ? <p>{t("account.thisDevice", { name: device.name })}</p> : null}
      <div className="button-row">
        <button type="button" disabled={status.phase === "syncing"} onClick={() => void engine.syncNow().catch(() => undefined)}>
          {t("sync.now")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await signOut(db, api, engine);
            setBusy(false);
          }}
        >
          {t("account.signOut")}
        </button>
      </div>
      <p className="hint">{t("account.signOutNote")}</p>
    </div>
  );
}

type ServerState = "checking" | "unreachable" | "needsSetup" | "ready";

function SignedOut() {
  const t = useT();
  const { api } = useServices();
  const online = useOnline();
  const [server, setServer] = useState<ServerState>("checking");

  useEffect(() => {
    if (!online) {
      setServer("unreachable");
      return;
    }
    let cancelled = false;
    setServer("checking");
    api
      .setupStatus()
      .then((s) => !cancelled && setServer(s.setupCompleted ? "ready" : "needsSetup"))
      .catch(() => !cancelled && setServer("unreachable"));
    return () => {
      cancelled = true;
    };
  }, [api, online]);

  if (server === "checking") return <p className="muted">{t("account.checking")}</p>;
  if (server === "unreachable") return <p className="notice notice-info">{t("account.serverOffline")}</p>;
  return <CredentialsForm mode={server === "needsSetup" ? "setup" : "login"} onSetupTaken={() => setServer("ready")} />;
}

function CredentialsForm({ mode, onSetupTaken }: { mode: "setup" | "login"; onSetupTaken: () => void }) {
  const t = useT();
  const { db, api, engine } = useServices();
  const ids = { email: useId(), password: useId(), token: useId(), device: useId(), error: useId() };
  const device = useLiveQuery(() => getMeta<DeviceIdentity>(db, "device"), [db]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input = { email, password, deviceName: deviceName.trim() || device?.name || "This device" };
    try {
      if (mode === "setup") await createOwnerAccount(db, api, engine, { ...input, setupToken });
      else await signIn(db, api, engine, input);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "SETUP_ALREADY_COMPLETED") onSetupTaken();
      setError(errorKey(e));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit} aria-describedby={error ? ids.error : undefined} noValidate>
      <h2>{mode === "setup" ? t("account.setupTitle") : t("account.loginTitle")}</h2>
      {mode === "setup" ? <p>{t("account.setupIntro")}</p> : null}
      <div className="field">
        <label htmlFor={ids.email}>{t("account.email")}</label>
        <input id={ids.email} type="email" autoComplete="username" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.password}>{t("account.password")}</label>
        <input
          id={ids.password}
          type="password"
          dir="ltr"
          autoComplete={mode === "setup" ? "new-password" : "current-password"}
          minLength={mode === "setup" ? PASSWORD_MIN_LENGTH : undefined}
          required
          aria-describedby={mode === "setup" ? `${ids.password}-hint` : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === "setup" ? (
          <p id={`${ids.password}-hint`} className="hint">
            {t("account.passwordHint")}
          </p>
        ) : null}
      </div>
      {mode === "setup" ? (
        <div className="field">
          <label htmlFor={ids.token}>{t("account.setupToken")}</label>
          <input
            id={ids.token}
            type="password"
            dir="ltr"
            autoComplete="off"
            aria-describedby={`${ids.token}-hint`}
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
          />
          <p id={`${ids.token}-hint`} className="hint">
            {t("account.setupTokenHint")}
          </p>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={ids.device}>{t("account.deviceName")}</label>
        <input
          id={ids.device}
          maxLength={80}
          placeholder={device?.name}
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
        />
      </div>
      {error ? (
        <p id={ids.error} className="notice notice-error" role="alert">
          {t(error)}
        </p>
      ) : null}
      <button type="submit" disabled={busy}>
        {busy ? t("account.working") : mode === "setup" ? t("account.create") : t("account.signIn")}
      </button>
    </form>
  );
}
