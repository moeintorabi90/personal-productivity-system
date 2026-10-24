import { useId, useState } from "react";
import { useT } from "../app-context.tsx";
import { formatDayNumber, formatLocalDate, formatMonthHeading, formatWeekdayShort } from "../i18n/index.ts";
import { NO_FILTER, type PlanFilter } from "../planning/planning.ts";
import { addDays, monthDates, shiftMonth, weekDates, weekdayOf } from "../planning/time.ts";
import { SearchField } from "./organization-ui.tsx";
import { DateField, DayPanel, dayPlan, type PlanningContext, TimeZonePrompt, usePlanning, useToday } from "./planning-ui.tsx";

type Mode = "day" | "week" | "month";

/** Stage 3 calendar: day, week, and month views with navigation, search, and filters. */
export function CalendarView({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const t = useT();
  const { ctx, loading, zone } = usePlanning();
  const today = useToday(zone);
  return (
    <section className="card" aria-labelledby="calendar-title">
      <h1 id="calendar-title">{t("calendar.title")}</h1>
      {!zone && !loading ? <TimeZonePrompt onOpenSettings={onOpenSettings} /> : null}
      {ctx && today ? <Calendar ctx={ctx} today={today} /> : null}
    </section>
  );
}

function Calendar({ ctx, today }: { ctx: PlanningContext; today: string }) {
  const t = useT();
  const ids = { mode: useId(), project: useId(), workstream: useId(), cancelled: useId(), unscheduled: useId() };
  const [mode, setMode] = useState<Mode>("week");
  const [focus, setFocus] = useState(today);
  const [goTo, setGoTo] = useState("");
  const [filter, setFilter] = useState<PlanFilter>(NO_FILTER);
  const monthCalendar = ctx.calendarDisplay === "jalali" ? "jalali" : "gregorian";

  function step(delta: -1 | 1) {
    if (mode === "day") setFocus(addDays(focus, delta));
    else if (mode === "week") setFocus(addDays(focus, 7 * delta));
    else setFocus(shiftMonth(focus, monthCalendar, delta));
  }

  const projects = ctx.org.projects.filter((p) => p.data.archivedAt === null || p.id === filter.project);
  const workstreams = ctx.org.workstreams.filter((w) => w.data.projectId === filter.project);

  return (
    <>
      <div className="filters calendar-toolbar">
        <div className="field">
          <label htmlFor={ids.mode}>{t("calendar.view")}</label>
          <select id={ids.mode} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="day">{t("calendar.day")}</option>
            <option value="week">{t("calendar.week")}</option>
            <option value="month">{t("calendar.month")}</option>
          </select>
        </div>
        <div className="button-row" role="group" aria-label={t("calendar.navigation")}>
          <button type="button" className="secondary" onClick={() => step(-1)}>
            {t("calendar.previous")}
          </button>
          <button type="button" className="secondary" onClick={() => setFocus(today)}>
            {t("calendar.today")}
          </button>
          <button type="button" className="secondary" onClick={() => step(1)}>
            {t("calendar.next")}
          </button>
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (goTo) setFocus(goTo);
          }}
        >
          <DateField label={t("calendar.goTo")} value={goTo} onChange={setGoTo} />
          <button type="submit" disabled={!goTo}>
            {t("calendar.go")}
          </button>
        </form>
      </div>
      <div className="filters">
        <SearchField label={t("calendar.search")} value={filter.query} onChange={(query) => setFilter({ ...filter, query })} />
        <div className="field">
          <label htmlFor={ids.project}>{t("org.task.project")}</label>
          <select id={ids.project} value={filter.project} onChange={(e) => setFilter({ ...filter, project: e.target.value, workstream: "" })}>
            <option value="">{t("calendar.allProjects")}</option>
            <option value="inbox">{t("calendar.inbox")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.data.name}
              </option>
            ))}
          </select>
        </div>
        {filter.project && filter.project !== "inbox" ? (
          <div className="field">
            <label htmlFor={ids.workstream}>{t("org.task.workstream")}</label>
            <select id={ids.workstream} value={filter.workstream} onChange={(e) => setFilter({ ...filter, workstream: e.target.value })}>
              <option value="">{t("calendar.allWorkstreams")}</option>
              {workstreams.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.data.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field checkbox-field">
          <input id={ids.cancelled} type="checkbox" checked={filter.showCancelled} onChange={(e) => setFilter({ ...filter, showCancelled: e.target.checked })} />
          <label htmlFor={ids.cancelled}>{t("calendar.showCancelled")}</label>
        </div>
        <div className="field checkbox-field">
          <input id={ids.unscheduled} type="checkbox" checked={filter.onlyUnscheduled} onChange={(e) => setFilter({ ...filter, onlyUnscheduled: e.target.checked })} />
          <label htmlFor={ids.unscheduled}>{t("calendar.onlyUnscheduled")}</label>
        </div>
      </div>
      {mode === "day" ? (
        <DayPanel ctx={ctx} plan={dayPlan(ctx, focus, filter)} />
      ) : mode === "week" ? (
        <WeekView ctx={ctx} focus={focus} filter={filter} />
      ) : (
        <MonthView ctx={ctx} focus={focus} filter={filter} calendar={monthCalendar} onOpenDay={(date) => {
          setFocus(date);
          setMode("day");
        }} />
      )}
    </>
  );
}

function WeekView({ ctx, focus, filter }: { ctx: PlanningContext; focus: string; filter: PlanFilter }) {
  const t = useT();
  const dates = weekDates(focus, ctx.weekStart);
  return (
    <div data-testid="week-view">
      <h2>{t("calendar.weekOf", { first: formatLocalDate(dates[0]!, ctx, "medium"), last: formatLocalDate(dates[6]!, ctx, "medium") })}</h2>
      <div className="week-grid">
        {dates.map((date) => (
          <DayPanel key={date} ctx={ctx} plan={dayPlan(ctx, date, filter)} headingLevel={3} />
        ))}
      </div>
    </div>
  );
}

function MonthView({
  ctx,
  focus,
  filter,
  calendar,
  onOpenDay,
}: {
  ctx: PlanningContext;
  focus: string;
  filter: PlanFilter;
  calendar: "gregorian" | "jalali";
  onOpenDay: (date: string) => void;
}) {
  const t = useT();
  const dates = monthDates(focus, calendar);
  const lead = (weekdayOf(dates[0]!) - ctx.weekStart + 7) % 7;
  const weekdays = Array.from({ length: 7 }, (_, i) => (ctx.weekStart + i) % 7);
  return (
    <div data-testid="month-view">
      <h2>{formatMonthHeading(focus, ctx)}</h2>
      <ol className="month-grid" aria-label={formatMonthHeading(focus, ctx)}>
        {weekdays.map((d) => (
          <li key={`h${d}`} className="month-weekday" aria-hidden="true">
            {formatWeekdayShort(d, ctx.language)}
          </li>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <li key={`pad${i}`} className="month-pad" aria-hidden="true" />
        ))}
        {dates.map((date) => {
          const plan = dayPlan(ctx, date, filter);
          const over = plan.capacity.kind === "warning";
          const label = t("calendar.monthCell", {
            date: formatLocalDate(date, ctx),
            blocks: plan.blocks.length,
            unscheduled: plan.unscheduled.length,
          });
          return (
            <li key={date} className={`month-cell${over ? " month-over" : ""}`} data-date={date}>
              <button type="button" className="month-day" aria-label={over ? `${label} ${t("calendar.overCapacity")}` : label} onClick={() => onOpenDay(date)}>
                <span className="month-number">{formatDayNumber(date, calendar, ctx.language)}</span>
                {ctx.calendarDisplay === "both" ? <span className="month-alt">{formatDayNumber(date, "jalali", ctx.language)}</span> : null}
                {plan.blocks.length ? <span className="month-count">{t("calendar.blocksCount", { count: plan.blocks.length })}</span> : null}
                {plan.unscheduled.length ? <span className="month-count">{t("calendar.unscheduledCount", { count: plan.unscheduled.length })}</span> : null}
                {over ? <span className="pill pill-warn month-over-pill">{t("calendar.overCapacity")}</span> : null}
                {/* Phone width: compact marks; the full text is in the button's label. */}
                <span className="month-compact" aria-hidden="true">
                  {plan.blocks.length ? `▪${plan.blocks.length} ` : ""}
                  {plan.unscheduled.length ? `○${plan.unscheduled.length} ` : ""}
                  {over ? "!" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
