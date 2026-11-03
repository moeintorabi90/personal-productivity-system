/**
 * The built-in timer (PRODUCT_SPEC "Timer"; DECISIONS T-230 to T-240; "Timer and floating view").
 * Three timers, one view: the open work session's elapsed time (from its stored start and pauses),
 * a standalone stopwatch, and a countdown. The in-app view and the optional floating window render
 * this same component against the same device-local state, and their commands act only on the
 * selected timer, so the floating window never holds a timer of its own. The floating control is
 * shown only when `documentPictureInPicture` exists (feature detection; no browser names, no other
 * floating method). When the floating window itself is small, it shows a compact view: the time and
 * the one main control of the selected timer (T-238). Nothing here completes a task, and a countdown
 * at zero never ends a session.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useServices, useT } from "../app-context.tsx";
import type { Translate } from "../i18n/index.ts";
import { type Session, endSession, openSessions, pauseSession, resumeSession } from "../local/work.ts";
import {
  countdownReachedZero,
  countdownRemaining,
  type CountdownState,
  durationFields,
  expireCountdown,
  loadTimer,
  pauseCountdown,
  pauseStopwatch,
  parseDuration,
  resetCountdown,
  resetStopwatch,
  resumeCountdown,
  saveCountdown,
  saveSelectedTimer,
  saveStopwatch,
  saveTimerSound,
  startCountdown,
  startStopwatch,
  stopwatchElapsed,
  TIMER_KINDS,
  type TimerKind,
  type TimerSettings,
} from "../local/timer.ts";
import { sessionState, workMs } from "../work/session-time.ts";
import { useWork } from "./data-hooks.ts";
import { workError } from "./work-actions.tsx";

/** `H:MM:SS` (or `M:SS`), with the language's digits. */
export function formatClock(ms: number, language: "en" | "fa"): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  const text = h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  return language === "fa" ? text.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!) : text;
}

function useTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/* ---------- the alert tone (T-233): Web Audio, no file, no dependency ---------- */

let audio: AudioContext | null = null;
/** Called from the user's own action (starting a countdown), which browsers require before audio plays. */
function prepareAudio(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!audio && Ctx) audio = new Ctx();
    void audio?.resume();
  } catch {
    audio = null;
  }
}
function playTone(): void {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.2, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.8);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.8);
}

/** Whether the browser offers Document Picture-in-Picture (decided by the API's presence only). */
export const floatingSupported = () => typeof window !== "undefined" && "documentPictureInPicture" in window;

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

/** Below this size of the floating window's own viewport (CSS pixels), it shows the compact view (T-238). */
export const COMPACT_FLOATING = { width: 300, height: 240 };
export const isCompactFloating = (win: Window) => win.innerWidth < COMPACT_FLOATING.width || win.innerHeight < COMPACT_FLOATING.height;

/**
 * The timer shown on every screen (T-230), with its floating window when supported. It also
 * watches the countdown: reaching zero while the app is open shows the message and plays the tone
 * (unless off); a zero that passed while the app was closed shows "expired" with no late tone.
 */
export function TimerBar({ onOpenWork }: { onOpenWork?: () => void }) {
  const t = useT();
  const { db } = useServices();
  const settings = useLiveQuery(() => loadTimer(db), [db]);
  const work = useWork();
  const now = useTick();
  const [pip, setPip] = useState<Window | null>(null);
  const [compact, setCompact] = useState(false);
  const [alert, setAlert] = useState(false);
  const observedRunning = useRef(false);

  // Countdown at zero (T-233, T-234): the state becomes expired; the tone plays only if this session saw it running.
  useEffect(() => {
    if (!settings) return;
    const c = settings.countdown;
    if (c.status === "running" && !countdownReachedZero(c, now)) observedRunning.current = true;
    if (c.status === "running" && countdownReachedZero(c, now)) {
      void saveCountdown(db, expireCountdown(c));
      if (observedRunning.current) {
        setAlert(true);
        if (settings.sound) playTone();
      }
      observedRunning.current = false;
    }
  }, [settings, now, db]);

  useEffect(() => () => pip?.close(), [pip]);

  // The compact view follows the floating window's own size, never the main window's (T-238).
  useEffect(() => {
    if (!pip) return;
    const update = () => setCompact(isCompactFloating(pip));
    update();
    pip.addEventListener("resize", update);
    return () => pip.removeEventListener("resize", update);
  }, [pip]);

  if (!settings || !work) return null;
  const open = openSessions(work.sessions);
  const panel = (floating: boolean) => (
    <TimerView settings={settings} sessions={open} importedPaused={work.importedPaused} now={now} floating={floating} compact={floating && compact} onOpenWork={onOpenWork} alert={alert} onDismissAlert={() => setAlert(false)} />
  );

  async function openFloating() {
    const api = (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
    if (!api) return;
    const win = await api.requestWindow({ width: 340, height: 300 });
    // The window renders the app's own components with the app's styles and direction.
    for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) win.document.head.appendChild(node.cloneNode(true));
    win.document.documentElement.lang = document.documentElement.lang;
    win.document.documentElement.dir = document.documentElement.dir;
    if (document.documentElement.dataset.theme) win.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    win.document.body.className = "pip-body";
    win.addEventListener("pagehide", () => setPip(null));
    setPip(win);
  }

  return (
    <details className="timer-bar" data-testid="timer-bar">
      <summary>
        {t("timer.title")}: <TimerSummary settings={settings} sessions={open} importedPaused={work.importedPaused} now={now} />
      </summary>
      {panel(false)}
      {floatingSupported() ? (
        <div className="button-row">
          {pip ? (
            <button type="button" className="secondary" onClick={() => pip.close()} data-testid="close-floating">
              {t("timer.closeFloating")}
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => void openFloating()} data-testid="open-floating">
              {t("timer.openFloating")}
            </button>
          )}
        </div>
      ) : null}
      {pip ? createPortal(<div className="pip-root" data-testid="floating-timer">{panel(true)}</div>, pip.document.body) : null}
    </details>
  );
}

function sessionElapsed(s: Session, importedPaused: Record<string, string>, now: number): { ms: number; paused: boolean } {
  const state = sessionState(s.data, importedPaused[s.id]);
  const until = state.kind === "paused" ? state.since : now;
  return { ms: workMs(s.data, until), paused: state.kind === "paused" };
}

function TimerSummary({ settings, sessions, importedPaused, now }: { settings: TimerSettings; sessions: Session[]; importedPaused: Record<string, string>; now: number }) {
  const t = useT();
  const language = document.documentElement.lang === "fa" ? "fa" : "en";
  if (settings.selected === "stopwatch") return <span>{t("timer.stopwatch")} {formatClock(stopwatchElapsed(settings.stopwatch, now), language)}</span>;
  if (settings.selected === "countdown") {
    const c = settings.countdown;
    return <span>{t("timer.countdown")} {countdownReachedZero(c, now) ? t("timer.expired") : formatClock(countdownRemaining(c, now), language)}</span>;
  }
  const s = sessions[0];
  return <span>{t("timer.session")} {s ? formatClock(sessionElapsed(s, importedPaused, now).ms, language) : t("timer.noSession")}</span>;
}

function TimerView({
  settings,
  sessions,
  importedPaused,
  now,
  floating,
  compact,
  onOpenWork,
  alert,
  onDismissAlert,
}: {
  settings: TimerSettings;
  sessions: Session[];
  importedPaused: Record<string, string>;
  now: number;
  floating: boolean;
  compact: boolean;
  onOpenWork?: () => void;
  alert: boolean;
  onDismissAlert: () => void;
}) {
  const t = useT();
  const { db } = useServices();
  const [error, setError] = useState<string | null>(null);
  const language = document.documentElement.lang === "fa" ? "fa" : "en";
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(workError(t, e));
    }
  };
  const errorNotice = error ? (
    <p className="notice notice-error" role="alert">
      {error}
    </p>
  ) : null;
  if (compact) {
    return (
      <div className="timer-view timer-floating timer-compact" data-testid="timer-view-floating" data-selected={settings.selected} data-compact="true" role="group" aria-label={t(`timer.${settings.selected}`)}>
        <CompactTimer t={t} settings={settings} sessions={sessions} importedPaused={importedPaused} now={now} language={language} act={act} />
        {errorNotice}
      </div>
    );
  }
  return (
    <div className={`timer-view${floating ? " timer-floating" : ""}`} data-testid={floating ? "timer-view-floating" : "timer-view"} data-selected={settings.selected}>
      <div className="button-row" role="tablist" aria-label={t("timer.choose")}>
        {TIMER_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={settings.selected === kind}
            className={settings.selected === kind ? "" : "secondary"}
            onClick={() => void saveSelectedTimer(db, kind)}
          >
            {t(`timer.${kind}`)}
          </button>
        ))}
      </div>
      {alert ? (
        <p className="notice notice-ok" role="alert" data-testid="countdown-done">
          {t("timer.countdownDone")}{" "}
          <button type="button" className="link-button" onClick={onDismissAlert}>
            {t("timer.dismiss")}
          </button>
        </p>
      ) : null}
      {settings.selected === "session" ? (
        <SessionTimer sessions={sessions} importedPaused={importedPaused} now={now} language={language} act={act} floating={floating} onOpenWork={onOpenWork} />
      ) : settings.selected === "stopwatch" ? (
        <Clock value={formatClock(stopwatchElapsed(settings.stopwatch, now), language)} status={t(`timer.status.${settings.stopwatch.status}`)}>
          {settings.stopwatch.status === "running" ? (
            <button type="button" onClick={act(() => saveStopwatch(db, pauseStopwatch(settings.stopwatch, Date.now())))}>
              {t("timer.pause")}
            </button>
          ) : (
            <button type="button" onClick={act(() => saveStopwatch(db, startStopwatch(settings.stopwatch, Date.now())))}>
              {settings.stopwatch.status === "paused" ? t("timer.resume") : t("timer.start")}
            </button>
          )}
          <button type="button" className="secondary" disabled={settings.stopwatch.status === "idle"} onClick={act(() => saveStopwatch(db, resetStopwatch()))}>
            {t("timer.reset")}
          </button>
          <p className="hint">{t("timer.stopwatchHint")}</p>
        </Clock>
      ) : (
        <CountdownTimer countdown={settings.countdown} sound={settings.sound} now={now} language={language} act={act} />
      )}
      {errorNotice}
    </div>
  );
}

/**
 * The compact floating view (T-238): the selected timer's time and its one main control (Pause while
 * running, Resume while paused, Start when ready), nothing else. With no session open it shows only
 * the short message and starts nothing. A countdown started here uses its last set length. It takes
 * the parent's translator, so switching to it never shows the default language while preferences load.
 */
function CompactTimer({
  t,
  settings,
  sessions,
  importedPaused,
  now,
  language,
  act,
}: {
  t: Translate;
  settings: TimerSettings;
  sessions: Session[];
  importedPaused: Record<string, string>;
  now: number;
  language: "en" | "fa";
  act: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  const { db } = useServices();
  let value: string;
  let main: { label: string; run: () => Promise<unknown> };
  if (settings.selected === "session") {
    const s = sessions[0];
    if (!s) {
      return (
        <p className="timer-compact-empty" data-testid="session-timer-empty">
          {t("timer.noSession")}
        </p>
      );
    }
    const { ms, paused } = sessionElapsed(s, importedPaused, now);
    value = formatClock(ms, language);
    main = paused ? { label: t("timer.resume"), run: () => resumeSession(db, s.id) } : { label: t("timer.pause"), run: () => pauseSession(db, s.id) };
  } else if (settings.selected === "stopwatch") {
    const sw = settings.stopwatch;
    value = formatClock(stopwatchElapsed(sw, now), language);
    main =
      sw.status === "running"
        ? { label: t("timer.pause"), run: () => saveStopwatch(db, pauseStopwatch(sw, Date.now())) }
        : { label: t(sw.status === "paused" ? "timer.resume" : "timer.start"), run: () => saveStopwatch(db, startStopwatch(sw, Date.now())) };
  } else {
    const c = settings.countdown;
    const expired = countdownReachedZero(c, now);
    value = formatClock(expired ? 0 : countdownRemaining(c, now), language);
    main =
      c.status === "running" && !expired
        ? { label: t("timer.pause"), run: () => saveCountdown(db, pauseCountdown(c, Date.now())) }
        : c.status === "paused"
          ? { label: t("timer.resume"), run: () => saveCountdown(db, resumeCountdown(c, Date.now())) }
          : {
              label: t("timer.start"),
              run: async () => {
                prepareAudio();
                await saveCountdown(db, startCountdown(c.durationMs, Date.now()));
              },
            };
  }
  return (
    <div className="timer-compact-row">
      <p className="timer-value" data-testid="timer-value" aria-live="off">
        {value}
      </p>
      <button type="button" onClick={act(main.run)}>
        {main.label}
      </button>
    </div>
  );
}

function Clock({ value, status, children }: { value: string; status: string; children: ReactNode }) {
  return (
    <div className="timer-clock">
      <p className="timer-value" data-testid="timer-value" aria-live="off">
        {value}
      </p>
      <p className="hint" data-testid="timer-status">
        {status}
      </p>
      <div className="button-row">{children}</div>
    </div>
  );
}

function SessionTimer({
  sessions,
  importedPaused,
  now,
  language,
  act,
  floating,
  onOpenWork,
}: {
  sessions: Session[];
  importedPaused: Record<string, string>;
  now: number;
  language: "en" | "fa";
  act: (fn: () => Promise<unknown>) => () => Promise<void>;
  floating: boolean;
  onOpenWork?: () => void;
}) {
  const t = useT();
  const { db } = useServices();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const s = sessions[0];
  if (!s) {
    // The usual way to start work is the Work screen (T-236: restoring the selection starts nothing).
    return (
      <div data-testid="session-timer-empty">
        <p className="muted">{t("timer.noSession")}</p>
        {!floating && onOpenWork ? (
          <button type="button" className="secondary" onClick={onOpenWork}>
            {t("timer.startWork")}
          </button>
        ) : null}
      </div>
    );
  }
  const { ms, paused } = sessionElapsed(s, importedPaused, now);
  const title = s.data.snapshot?.taskTitle ?? t("work.noTask");
  return (
    <Clock value={formatClock(ms, language)} status={`${title}${t("stage6.sep")}${paused ? t("timer.status.paused") : t("timer.status.running")}`}>
      {paused ? (
        <button type="button" onClick={act(() => resumeSession(db, s.id))}>
          {t("timer.resume")}
        </button>
      ) : (
        <button type="button" onClick={act(() => pauseSession(db, s.id))}>
          {t("timer.pause")}
        </button>
      )}
      {confirmEnd ? (
        <>
          <button type="button" onClick={act(async () => (await endSession(db, s.id), setConfirmEnd(false)))}>
            {t("timer.confirmEnd")}
          </button>
          <button type="button" className="secondary" onClick={() => setConfirmEnd(false)}>
            {t("org.cancel")}
          </button>
        </>
      ) : (
        <button type="button" className="secondary" onClick={() => setConfirmEnd(true)}>
          {t("timer.end")}
        </button>
      )}
      <p className="hint">{t("timer.endHint")}</p>
      {sessions.length > 1 ? <p className="notice notice-warn">{t("work.error.TWO_OPEN_SESSIONS")}</p> : null}
    </Clock>
  );
}

function CountdownTimer({ countdown, sound, now, language, act }: { countdown: CountdownState; sound: boolean; now: number; language: "en" | "fa"; act: (fn: () => Promise<unknown>) => () => Promise<void> }) {
  const t = useT();
  const { db } = useServices();
  const ids = { hours: useId(), minutes: useId(), seconds: useId(), sound: useId() };
  // The length being set (T-239): a draft until Start, so editing it never changes a running or paused countdown.
  const [fields, setFields] = useState(() => durationFields(countdown.durationMs));
  useEffect(() => setFields(durationFields(countdown.durationMs)), [countdown.durationMs]);
  const parsed = parseDuration(fields);
  const expired = countdownReachedZero(countdown, now);
  return (
    <Clock value={expired ? formatClock(0, language) : formatClock(countdownRemaining(countdown, now), language)} status={expired ? t("timer.expired") : t(`timer.status.${countdown.status}`)}>
      {countdown.status === "running" && !expired ? (
        <button type="button" onClick={act(() => saveCountdown(db, pauseCountdown(countdown, Date.now())))}>
          {t("timer.pause")}
        </button>
      ) : countdown.status === "paused" ? (
        <button type="button" onClick={act(() => saveCountdown(db, resumeCountdown(countdown, Date.now())))}>
          {t("timer.resume")}
        </button>
      ) : (
        <>
          <fieldset className="field date-parts" data-testid="countdown-length">
            <legend>{t("timer.duration")}</legend>
            <div className="date-parts-row">
              {(["hours", "minutes", "seconds"] as const).map((part) => (
                <span key={part} className="duration-part">
                  <input id={ids[part]} inputMode="numeric" size={3} value={fields[part]} aria-invalid={!parsed.ok} onChange={(e) => setFields({ ...fields, [part]: e.target.value })} />
                  <label htmlFor={ids[part]}>{t(`timer.${part}`)}</label>
                </span>
              ))}
            </div>
            {parsed.ok ? null : (
              <p className="hint hint-error" data-testid="countdown-length-error">
                {t(`timer.lengthError.${parsed.error}`)}
              </p>
            )}
          </fieldset>
          <button
            type="button"
            disabled={!parsed.ok}
            onClick={act(async () => {
              if (!parsed.ok) return;
              prepareAudio();
              await saveCountdown(db, startCountdown(parsed.ms, Date.now()));
            })}
          >
            {t("timer.start")}
          </button>
        </>
      )}
      <button type="button" className="secondary" disabled={countdown.status === "idle"} onClick={act(() => saveCountdown(db, resetCountdown(countdown)))}>
        {t("timer.reset")}
      </button>
      <span className="checkbox-field">
        <input id={ids.sound} type="checkbox" checked={sound} onChange={(e) => void saveTimerSound(db, e.target.checked)} />
        <label htmlFor={ids.sound}>{t("timer.sound")}</label>
      </span>
      <p className="hint">{t("timer.countdownHint")}</p>
    </Clock>
  );
}
