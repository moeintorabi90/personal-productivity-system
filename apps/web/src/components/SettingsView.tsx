import {
  CALENDAR_DISPLAYS,
  isValidTimeZone,
  LANGUAGES,
  type PreferencePatch,
  THEMES,
} from "@pps/shared";
import { useId, useMemo, useState } from "react";
import { usePreferences, useServices, useT } from "../app-context.tsx";
import { formatDateTime } from "../i18n/index.ts";
import { updatePreferences } from "../local/repository.ts";

function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

export function SettingsView() {
  const t = useT();
  const prefs = usePreferences();
  const { db, engine } = useServices();
  const ids = { language: useId(), theme: useId(), calendar: useId(), week: useId(), zone: useId(), zones: useId() };
  const [zoneDraft, setZoneDraft] = useState<string | null>(null);
  const zones = useMemo(allTimeZones, []);
  const suggested = deviceTimeZone();
  const sampleDate = useMemo(() => new Date().toISOString(), []);

  async function save(patch: PreferencePatch) {
    await updatePreferences(db, patch);
    engine.requestSync();
  }

  const zoneValue = zoneDraft ?? prefs.timeZone ?? "";
  const zoneInvalid = zoneDraft !== null && zoneDraft !== "" && !isValidTimeZone(zoneDraft);

  return (
    <section className="card" aria-labelledby="settings-title">
      <h1 id="settings-title">{t("settings.title")}</h1>
      <p className="muted">{t("settings.saved")}</p>

      <div className="field">
        <label htmlFor={ids.language}>{t("settings.language")}</label>
        <select
          id={ids.language}
          value={prefs.language}
          onChange={(e) => save({ language: e.target.value as (typeof LANGUAGES)[number] })}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang} lang={lang}>
              {t(`settings.language.${lang}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={ids.theme}>{t("settings.theme")}</label>
        <select id={ids.theme} value={prefs.theme} onChange={(e) => save({ theme: e.target.value as (typeof THEMES)[number] })}>
          {THEMES.map((theme) => (
            <option key={theme} value={theme}>
              {t(`settings.theme.${theme}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={ids.calendar}>{t("settings.calendar")}</label>
        <select
          id={ids.calendar}
          value={prefs.calendarDisplay}
          aria-describedby={`${ids.calendar}-hint`}
          onChange={(e) => save({ calendarDisplay: e.target.value as (typeof CALENDAR_DISPLAYS)[number] })}
        >
          {CALENDAR_DISPLAYS.map((cal) => (
            <option key={cal} value={cal}>
              {t(`settings.calendar.${cal}`)}
            </option>
          ))}
        </select>
        <p id={`${ids.calendar}-hint`} className="hint">
          {t("settings.calendarHint")} {t("settings.sample", { date: formatDateTime(sampleDate, prefs) })}
        </p>
      </div>

      <div className="field">
        <label htmlFor={ids.week}>{t("settings.weekStart")}</label>
        <select id={ids.week} value={prefs.weekStart} onChange={(e) => save({ weekStart: Number(e.target.value) })}>
          {[6, 0, 1, 2, 3, 4, 5].map((day) => (
            <option key={day} value={day}>
              {t(`weekday.${day}` as "weekday.0")}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={ids.zone}>{t("settings.timeZone")}</label>
        <input
          id={ids.zone}
          list={ids.zones}
          value={zoneValue}
          placeholder={t("settings.timeZoneNotSet")}
          aria-invalid={zoneInvalid}
          aria-describedby={`${ids.zone}-hint`}
          dir="ltr"
          onChange={(e) => setZoneDraft(e.target.value)}
          onBlur={async () => {
            if (zoneDraft === null) return;
            const value = zoneDraft.trim();
            if (value === "") await save({ timeZone: null });
            else if (isValidTimeZone(value)) await save({ timeZone: value });
            else return;
            setZoneDraft(null);
          }}
        />
        <datalist id={ids.zones}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p id={`${ids.zone}-hint`} className={zoneInvalid ? "hint hint-error" : "hint"}>
          {zoneInvalid ? t("settings.timeZoneInvalid") : t("settings.timeZoneHint")}
        </p>
        {suggested && suggested !== prefs.timeZone ? (
          <button type="button" className="secondary" onClick={() => save({ timeZone: suggested })}>
            {t("settings.timeZoneSuggest", { zone: suggested })}
          </button>
        ) : null}
      </div>
    </section>
  );
}
