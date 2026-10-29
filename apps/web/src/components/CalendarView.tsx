import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "../app-context.tsx";
import { formatDayNumber, formatLocalDate, formatMonthHeading, formatWeekdayShort } from "../i18n/index.ts";
import type { BlockTimeInput } from "../local/planning.ts";
import { NO_FILTER, type PlanFilter } from "../planning/planning.ts";
import { addDays, monthDates, shiftMonth, weekDates, weekdayOf } from "../planning/time.ts";
import { SearchField } from "./organization-ui.tsx";
import { ReopenButton } from "./work-actions.tsx";
import { BlockForm, BlockRow, DateField, DayPanel, dayPlan, type PlanningContext, TimeZonePrompt, UnscheduledRow, usePlanning, useToday } from "./planning-ui.tsx";
import { TimeGrid } from "./TimeGrid.tsx";
import { UndoBar, type UndoOffer } from "./UndoBar.tsx";

type Mode = "day" | "week" | "month";
type Layout = "grid" | "list";

/** The phone layout (T-089): the same breakpoint as the rest of the narrow layout in styles.css. */
export const PHONE_QUERY = "(max-width: 560px)";

function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

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
  const ids = { mode: useId(), layout: useId(), project: useId(), workstream: useId(), cancelled: useId(), unscheduled: useId() };
  const [mode, setMode] = useState<Mode>("week");
  const [layout, setLayout] = useState<Layout>("grid");
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
        {mode !== "month" ? (
          <div className="field">
            <label htmlFor={ids.layout}>{t("calendar.layout")}</label>
            <select id={ids.layout} value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
              <option value="grid">{t("calendar.layout.grid")}</option>
              <option value="list">{t("calendar.layout.list")}</option>
            </select>
          </div>
        ) : null}
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
      {mode !== "month" && layout === "grid" ? (
        <GridView ctx={ctx} dates={mode === "day" ? [focus] : weekDates(focus, ctx.weekStart)} focus={focus} filter={filter} week={mode === "week"} />
      ) : mode === "day" ? (
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

type Panel = { kind: "new"; date: string; startTime?: string; durationMinutes?: number } | { kind: "block"; blockId: string } | null;

/**
 * Day or week as a time grid (T-066, T-067, T-089). On a phone the week shows two days at a time,
 * moved with Previous/Next days (and a sideways swipe). Forms open below the grid; an opened block
 * shows its row (edit, cancel, restore), which is also the keyboard path.
 */
function GridView({ ctx, dates, focus, filter, week }: { ctx: PlanningContext; dates: string[]; focus: string; filter: PlanFilter; week: boolean }) {
  const t = useT();
  const phone = useMediaQuery(PHONE_QUERY);
  const twoDays = week && phone;
  const lastFirst = Math.max(dates.length - 2, 0);
  const focusIndex = Math.max(dates.indexOf(focus), 0);
  const [first, setFirst] = useState(Math.min(focusIndex, lastFirst));
  const [panel, setPanel] = useState<Panel>(null);
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const weekKey = dates[0];
  useEffect(() => setFirst(Math.min(focusIndex, lastFirst)), [weekKey, focusIndex, lastFirst]);
  const shown = twoDays ? dates.slice(first, first + 2) : dates;
  const step = useCallback((delta: 1 | -1) => setFirst((f) => Math.max(0, Math.min(lastFirst, f + 2 * delta))), [lastFirst]);
  const closeUndo = useCallback(() => setOffer(null), []);
  const openBlock = panel?.kind === "block" ? ctx.blocks.find((b) => b.id === panel.blockId) : undefined;

  return (
    <div data-testid={week ? "grid-week-view" : "grid-day-view"}>
      <h2>
        {week
          ? t("calendar.weekOf", { first: formatLocalDate(dates[0]!, ctx, "medium"), last: formatLocalDate(dates[dates.length - 1]!, ctx, "medium") })
          : formatLocalDate(dates[0]!, ctx)}
      </h2>
      {twoDays ? (
        <div className="button-row" role="group" aria-label={t("grid.daysNavigation")}>
          <button type="button" className="secondary" disabled={first === 0} onClick={() => step(-1)}>
            {t("grid.previousDays")}
          </button>
          <button type="button" className="secondary" disabled={first >= lastFirst} onClick={() => step(1)}>
            {t("grid.nextDays")}
          </button>
        </div>
      ) : null}
      <p className="hint">{t("grid.hint")}</p>
      {offer ? <UndoBar offer={offer} blocks={ctx.blocks} onClose={closeUndo} onError={setError} /> : null}
      {error ? (
        <p className="notice notice-error" role="alert" data-testid="grid-error">
          {error}
        </p>
      ) : null}
      <TimeGrid
        ctx={ctx}
        dates={shown}
        filter={filter}
        onCreate={(input: BlockTimeInput) => {
          setError(null);
          setPanel({ kind: "new", date: input.date, startTime: input.startTime, durationMinutes: input.durationMinutes });
        }}
        onAdd={(date) => {
          setError(null);
          setPanel({ kind: "new", date });
        }}
        onOpenBlock={(block) => {
          setError(null);
          setPanel({ kind: "block", blockId: block.id });
        }}
        onMoved={(o) => {
          setError(null);
          setOffer(o);
        }}
        onError={setError}
        onSwipe={twoDays ? step : undefined}
      />
      {panel?.kind === "new" ? (
        <BlockForm key={`${panel.date}/${panel.startTime ?? ""}/${panel.durationMinutes ?? ""}`} ctx={ctx} mode={panel} onDone={() => setPanel(null)} />
      ) : null}
      {openBlock ? (
        <ul className="item-list" aria-label={t("plan.blocks")} data-testid="opened-block">
          <BlockRow ctx={ctx} block={openBlock} date={openBlock.data.localDate} overlaps={false} />
        </ul>
      ) : null}
      <GridUnscheduled ctx={ctx} dates={shown} filter={filter} />
      <GridCompleted ctx={ctx} dates={shown} filter={filter} />
    </div>
  );
}

/** Unscheduled items of the shown dates (D-019): listed below the grid, each with "Schedule". */
function GridUnscheduled({ ctx, dates, filter }: { ctx: PlanningContext; dates: string[]; filter: PlanFilter }) {
  const t = useT();
  const groups = dates.map((date) => ({ date, items: dayPlan(ctx, date, filter).unscheduled })).filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <section className="day-panel" aria-label={t("plan.unscheduledHeading")} data-testid="grid-unscheduled">
      <h3>{t("plan.unscheduledHeading")}</h3>
      {groups.map(({ date, items }) => (
        <div key={date}>
          <p className="hint">{formatLocalDate(date, ctx, "medium")}</p>
          <ul className="item-list">
            {items.map((item) => (
              <UnscheduledRow key={`${item.taskId}/${item.date}`} ctx={ctx} item={item} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Completed tasks and occurrences of the shown dates (T-134), listed below the grid with a marker and "Reopen". */
function GridCompleted({ ctx, dates, filter }: { ctx: PlanningContext; dates: string[]; filter: PlanFilter }) {
  const t = useT();
  const groups = dates.map((date) => ({ date, items: dayPlan(ctx, date, filter).completed })).filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <section className="day-panel" aria-label={t("work.completedHeading")} data-testid="grid-completed">
      <h3>{t("work.completedHeading")}</h3>
      {groups.map(({ date, items }) => (
        <div key={date}>
          <p className="hint">{formatLocalDate(date, ctx, "medium")}</p>
          <ul className="item-list">
            {items.map((c) => {
              const title = ctx.tasks.get(c.data.taskId)?.title ?? t("org.unknownItem");
              return (
                <li key={c.id} className="item completed-row" data-testid="completed-row">
                  <div className="item-main">
                    <span className="item-title">{title}</span> <span className="pill pill-ok">{t("work.completed")}</span>
                  </div>
                  <div className="button-row">
                    <ReopenButton taskId={c.data.taskId} occurrenceDate={c.data.occurrenceDate} title={title} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
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
          }) + (plan.completed.length ? ` ${t("calendar.completedCount", { count: plan.completed.length })}` : "");
          return (
            <li key={date} className={`month-cell${over ? " month-over" : ""}`} data-date={date}>
              <button type="button" className="month-day" aria-label={over ? `${label} ${t("calendar.overCapacity")}` : label} onClick={() => onOpenDay(date)}>
                <span className="month-number">{formatDayNumber(date, calendar, ctx.language)}</span>
                {ctx.calendarDisplay === "both" ? <span className="month-alt">{formatDayNumber(date, "jalali", ctx.language)}</span> : null}
                {plan.blocks.length ? <span className="month-count">{t("calendar.blocksCount", { count: plan.blocks.length })}</span> : null}
                {plan.unscheduled.length ? <span className="month-count">{t("calendar.unscheduledCount", { count: plan.unscheduled.length })}</span> : null}
                {plan.completed.length ? <span className="month-count">{t("calendar.completedCount", { count: plan.completed.length })}</span> : null}
                {over ? <span className="pill pill-warn month-over-pill">{t("calendar.overCapacity")}</span> : null}
                {/* Phone width: compact marks; the full text is in the button's label. */}
                <span className="month-compact" aria-hidden="true">
                  {plan.blocks.length ? `▪${plan.blocks.length} ` : ""}
                  {plan.unscheduled.length ? `○${plan.unscheduled.length} ` : ""}
                  {plan.completed.length ? `✓${plan.completed.length} ` : ""}
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
