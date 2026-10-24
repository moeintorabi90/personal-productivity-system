/**
 * Shared pieces of the Stage 3 screens (Calendar, Today, task scheduling): live planning data,
 * date entry in the display calendar, the block form, block and unscheduled-item rows, and the
 * capacity summary. Every write is an explicit user action (D-019, D-021).
 */
import type { CalendarDisplay, Language } from "@pps/shared";
import { isValidTimeZone } from "@pps/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { usePreferences, useServices, useT } from "../app-context.tsx";
import { BLOCK_MAX_MINUTES, type CalendarBlockData, DEFAULT_SHARED_PREFERENCES, NAME_MAX, type SharedPreferences, type TaskDefinitionData } from "../backup/registry.ts";
import { formatLocalDate, formatTime, type MessageKey, type Translate } from "../i18n/index.ts";
import type { Organization } from "../local/organization.ts";
import { createBlock, loadBlocks, PlanningError, quickAddBlock, setBlockCancelled, updateBlock } from "../local/planning.ts";
import { RecordRuleError } from "../local/records.ts";
import { getSharedPreferences, updateSharedPreferences } from "../local/settings.ts";
import {
  blockLabel,
  type BlockItem,
  blocksOn,
  capacityStatus,
  type CapacityStatus,
  filterBlocks,
  filterUnscheduled,
  overlapGroups,
  overlappingBlockIds,
  type PlanFilter,
  plannedMinutesOn,
  type UnscheduledItem,
  unscheduledItemsOn,
} from "../planning/planning.ts";
import { formatOffset, fromJalali, isLocalDate, isWallTime, localDateOf, MINUTE_MS, resolveWallTime, toJalali, wallTimeOf } from "../planning/time.ts";
import { useOrganization } from "./data-hooks.ts";

/* ---------------- data ---------------- */

export function useSharedPreferences(): SharedPreferences {
  const { db } = useServices();
  return useLiveQuery(() => getSharedPreferences(db), [db]) ?? DEFAULT_SHARED_PREFERENCES;
}

export function useBlocks(): BlockItem[] | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadBlocks(db), [db]);
}

export interface PlanningContext {
  org: Organization;
  blocks: BlockItem[];
  tasks: Map<string, TaskDefinitionData>;
  zone: string;
  capacity: number | undefined;
  language: Language;
  calendarDisplay: CalendarDisplay;
  weekStart: number;
}

/** Everything the planning screens read, or null while loading / without a zone. */
export function usePlanning(): { ctx: PlanningContext | null; loading: boolean; zone: string | null } {
  const org = useOrganization();
  const blocks = useBlocks();
  const shared = useSharedPreferences();
  const prefs = usePreferences();
  const ctx = useMemo(() => {
    if (!org || !blocks || !shared.timeZone) return null;
    return {
      org,
      blocks,
      tasks: new Map(org.tasks.map((t) => [t.id, t.data])),
      zone: shared.timeZone,
      capacity: shared.dailyCapacityMinutes,
      language: prefs.language,
      calendarDisplay: prefs.calendarDisplay,
      weekStart: prefs.weekStart,
    };
  }, [org, blocks, shared, prefs.language, prefs.calendarDisplay, prefs.weekStart]);
  return { ctx, loading: !org || !blocks, zone: shared.timeZone };
}

/** Today's local date in the configured zone; re-reads the clock every minute (passing midnight writes nothing). */
export function useToday(zone: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return zone ? localDateOf(now, zone) : null;
}

export interface DayPlan {
  date: string;
  blocks: BlockItem[];
  overlaps: Set<string>;
  unscheduled: UnscheduledItem[];
  capacity: CapacityStatus;
}

/** One date as the views show it: filtered blocks and items; capacity always from ALL planned work. */
export function dayPlan(ctx: PlanningContext, date: string, filter: PlanFilter): DayPlan {
  const allItems = unscheduledItemsOn(ctx.org.tasks, ctx.blocks, date);
  const shown = blocksOn(filterBlocks(ctx.blocks, filter, ctx.tasks), date, ctx.zone);
  return {
    date,
    blocks: shown,
    overlaps: overlappingBlockIds(ctx.blocks, date, ctx.zone),
    unscheduled: filterUnscheduled(allItems, filter, ctx.tasks),
    capacity: capacityStatus(ctx.capacity, plannedMinutesOn(ctx.blocks, date, ctx.zone), allItems, ctx.tasks),
  };
}

/* ---------------- messages ---------------- */

export function planningError(t: Translate, error: unknown): string {
  if (error instanceof PlanningError) return t(`plan.error.${error.code}` as MessageKey);
  if (error instanceof RecordRuleError && error.code === "BROKEN_LINK") return t("plan.error.NOT_FOUND");
  return t("org.error.generic");
}

export function formatMinutes(t: Translate, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t("plan.minutes", { m });
  return m === 0 ? t("plan.hours", { h }) : t("plan.hoursMinutes", { h, m });
}

/* ---------------- time zone prompt (T-028) ---------------- */

function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Shown instead of planning screens until a zone is set; the device zone is only a suggestion. */
export function TimeZonePrompt({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const t = useT();
  const { db } = useServices();
  const suggested = deviceTimeZone();
  return (
    <div className="notice notice-info" data-testid="zone-prompt">
      <p>{t("plan.zonePrompt")}</p>
      <div className="button-row">
        {suggested ? (
          <button type="button" onClick={() => updateSharedPreferences(db, { timeZone: suggested })}>
            {t("settings.timeZoneSuggest", { zone: suggested })}
          </button>
        ) : null}
        {onOpenSettings ? (
          <button type="button" className="secondary" onClick={onOpenSettings}>
            {t("nav.settings")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- date entry in the display calendar ---------------- */

/**
 * A date input that follows the display calendar: Gregorian (and "Both", with the Jalali date
 * shown below) use the browser's date input; Jalali uses year/month/day fields. The value is
 * always an ISO Gregorian date ("" while empty or invalid).
 */
export function DateField({
  label,
  value,
  onChange,
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: ReactNode;
}) {
  const t = useT();
  const prefs = usePreferences();
  const id = useId();
  if (prefs.calendarDisplay === "jalali") return <JalaliDateField label={label} value={value} onChange={onChange} required={required} hint={hint} />;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="date" value={value} required={required} onChange={(e) => onChange(isLocalDate(e.target.value) ? e.target.value : "")} />
      {prefs.calendarDisplay === "both" && value ? <p className="hint">{t("plan.jalaliEquivalent", { date: formatLocalDate(value, { ...prefs, calendarDisplay: "jalali" }) })}</p> : null}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

function JalaliDateField({ label, value, onChange, required, hint }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; hint?: ReactNode }) {
  const t = useT();
  const prefs = usePreferences();
  const ids = { y: useId(), m: useId(), d: useId() };
  const initial = value ? toJalali(value) : null;
  const [parts, setParts] = useState({ y: initial ? String(initial.year) : "", m: initial ? String(initial.month) : "", d: initial ? String(initial.day) : "" });
  // Follow outside changes (e.g. navigation) without overwriting what is being typed.
  useEffect(() => {
    if (!value) return;
    const j = toJalali(value);
    setParts((p) => (fromJalali(Number(p.y), Number(p.m), Number(p.d)) === value ? p : { y: String(j.year), m: String(j.month), d: String(j.day) }));
  }, [value]);
  const iso = parts.y && parts.m && parts.d ? fromJalali(Number(parts.y), Number(parts.m), Number(parts.d)) : null;
  const invalid = !!(parts.y && parts.m && parts.d) && iso === null;
  function set(next: typeof parts) {
    setParts(next);
    const converted = next.y && next.m && next.d ? fromJalali(Number(next.y), Number(next.m), Number(next.d)) : null;
    onChange(converted ?? "");
  }
  return (
    <fieldset className="field date-parts">
      <legend>{label}</legend>
      <div className="date-parts-row" dir="ltr">
        <label htmlFor={ids.y}>{t("plan.date.year")}</label>
        <input id={ids.y} inputMode="numeric" size={5} value={parts.y} required={required} aria-invalid={invalid} onChange={(e) => set({ ...parts, y: e.target.value.trim() })} />
        <label htmlFor={ids.m}>{t("plan.date.month")}</label>
        <input id={ids.m} inputMode="numeric" size={3} value={parts.m} required={required} aria-invalid={invalid} onChange={(e) => set({ ...parts, m: e.target.value.trim() })} />
        <label htmlFor={ids.d}>{t("plan.date.day")}</label>
        <input id={ids.d} inputMode="numeric" size={3} value={parts.d} required={required} aria-invalid={invalid} onChange={(e) => set({ ...parts, d: e.target.value.trim() })} />
      </div>
      {invalid ? <p className="hint hint-error">{t("plan.date.invalid")}</p> : iso ? <p className="hint">{formatLocalDate(iso, { ...prefs, calendarDisplay: "both" })}</p> : null}
      {hint ? <p className="hint">{hint}</p> : null}
    </fieldset>
  );
}

/* ---------------- block form ---------------- */

export type BlockFormMode =
  | { kind: "new"; date: string } // from the calendar: an existing task, or quick add from a title
  | { kind: "task"; taskId: string; date: string } // "Plan" on a task
  | { kind: "schedule"; taskId: string; occurrenceDate: string } // "Schedule" on an unscheduled item
  | { kind: "edit"; block: BlockItem };

/**
 * Creates or edits a block. The start time is ALWAYS entered by the user (never pre-filled for a
 * new block, D-019, T-033); scheduling pre-fills the occurrence date and the task's estimate.
 * A daylight-saving gap is refused; an ambiguous time uses the earlier instant and shows its
 * offset (T-030). A capacity warning informs but never blocks saving (D-021).
 */
export function BlockForm({ ctx, mode, onDone }: { ctx: PlanningContext; mode: BlockFormMode; onDone: () => void }) {
  const t = useT();
  const { db } = useServices();
  const ids = { task: useId(), title: useId(), start: useId(), duration: useId() };
  const editing = mode.kind === "edit" ? mode.block : null;
  const fixedTaskId = mode.kind === "task" || mode.kind === "schedule" ? mode.taskId : editing ? editing.data.taskId : null;
  const estimate = fixedTaskId ? (ctx.tasks.get(fixedTaskId)?.estimateMinutes ?? null) : null;
  const [taskChoice, setTaskChoice] = useState<string>(""); // "" = quick add (new task from a title)
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(
    mode.kind === "edit" ? localDateOf(mode.block.data.startsAt, ctx.zone) : mode.kind === "schedule" ? mode.occurrenceDate : mode.date,
  );
  const [startTime, setStartTime] = useState(editing ? wallTimeOf(editing.data.startsAt, ctx.zone) : "");
  const [duration, setDuration] = useState(
    editing
      ? String((Date.parse(editing.data.endsAt) - Date.parse(editing.data.startsAt)) / MINUTE_MS)
      : mode.kind === "schedule" && estimate !== null && estimate <= BLOCK_MAX_MINUTES
        ? String(estimate)
        : "",
  );
  const [error, setError] = useState<string | null>(null);

  const activeTasks = ctx.org.tasks.filter((task) => task.data.archivedAt === null).sort((a, b) => a.data.title.localeCompare(b.data.title));
  const minutes = Number(duration);
  const durationValid = duration.trim() !== "" && Number.isInteger(minutes) && minutes >= 1 && minutes <= BLOCK_MAX_MINUTES;
  const wall = isLocalDate(date) && isWallTime(startTime) ? resolveWallTime(date, startTime, ctx.zone) : null;
  const needsTitle = mode.kind === "new" && taskChoice === "";
  const ready = !!wall && wall.kind === "ok" && durationValid && (!needsTitle || title.trim() !== "");

  // Capacity after this save, for every date the block touches (informational only).
  const overDates = useMemo(() => {
    if (!wall || wall.kind !== "ok" || !durationValid || ctx.capacity === undefined) return [];
    const startsAt = wall.instant;
    const endsAt = new Date(Date.parse(startsAt) + minutes * MINUTE_MS).toISOString();
    // Only the instants and status matter for planned minutes.
    const draft = { id: "draft", data: { startsAt, endsAt, status: "planned" } as CalendarBlockData };
    const after = [...ctx.blocks.filter((b) => b.id !== editing?.id), draft];
    const dates = [...new Set([localDateOf(startsAt, ctx.zone), localDateOf(Date.parse(endsAt) - 1, ctx.zone)])];
    return dates
      .map((d) => ({ date: d, planned: plannedMinutesOn(after, d, ctx.zone) }))
      .filter((o) => o.planned > ctx.capacity!);
  }, [wall, durationValid, minutes, ctx, editing]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    const time = { date, startTime, durationMinutes: minutes };
    try {
      if (mode.kind === "edit") await updateBlock(db, mode.block.id, time);
      else if (mode.kind === "schedule") await createBlock(db, { ...time, taskId: mode.taskId, occurrenceDate: mode.occurrenceDate });
      else if (mode.kind === "task") await createBlock(db, { ...time, taskId: mode.taskId });
      else if (taskChoice) await createBlock(db, { ...time, taskId: taskChoice });
      else await quickAddBlock(db, { ...time, title });
      onDone();
    } catch (e) {
      setError(planningError(t, e));
    }
  }

  const heading =
    mode.kind === "edit"
      ? t("plan.form.edit")
      : mode.kind === "schedule"
        ? t("plan.form.schedule", { title: ctx.tasks.get(mode.taskId)?.title ?? "" })
        : mode.kind === "task"
          ? t("plan.form.planTask", { title: ctx.tasks.get(mode.taskId)?.title ?? "" })
          : t("plan.form.new");

  return (
    <form className="editor" onSubmit={onSubmit} aria-label={heading}>
      <p className="item-title">{heading}</p>
      {mode.kind === "schedule" ? (
        <p className="hint">{t("plan.form.occurrence", { date: formatLocalDate(mode.occurrenceDate, ctx) })}</p>
      ) : null}
      {mode.kind === "new" ? (
        <>
          <div className="field">
            <label htmlFor={ids.task}>{t("plan.form.task")}</label>
            <select id={ids.task} value={taskChoice} onChange={(e) => setTaskChoice(e.target.value)}>
              <option value="">{t("plan.form.quickAdd")}</option>
              {activeTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.data.title}
                </option>
              ))}
            </select>
          </div>
          {needsTitle ? (
            <div className="field">
              <label htmlFor={ids.title}>{t("plan.form.title")}</label>
              <input id={ids.title} value={title} maxLength={NAME_MAX} onChange={(e) => setTitle(e.target.value)} />
              <p className="hint">{t("plan.form.quickAddHint")}</p>
            </div>
          ) : null}
        </>
      ) : null}
      <DateField label={t("plan.form.date")} value={date} onChange={setDate} required />
      <div className="field">
        <label htmlFor={ids.start}>{t("plan.form.start")}</label>
        <input id={ids.start} type="time" step={60} value={startTime} required onChange={(e) => setStartTime(e.target.value.slice(0, 5))} aria-describedby={`${ids.start}-hint`} />
        <p id={`${ids.start}-hint`} className={wall?.kind === "gap" ? "hint hint-error" : "hint"} role={wall?.kind === "gap" ? "alert" : undefined}>
          {wall?.kind === "gap"
            ? t("plan.form.gap", { zone: ctx.zone })
            : wall?.kind === "ok" && wall.ambiguous
              ? t("plan.form.ambiguous", { offset: formatOffset(wall.offsetMinutes) })
              : t("plan.form.startHint", { zone: ctx.zone })}
        </p>
      </div>
      <div className="field">
        <label htmlFor={ids.duration}>{t("plan.form.duration")}</label>
        <input
          id={ids.duration}
          type="number"
          inputMode="numeric"
          min={1}
          max={BLOCK_MAX_MINUTES}
          step={1}
          value={duration}
          aria-invalid={duration !== "" && !durationValid}
          onChange={(e) => setDuration(e.target.value)}
        />
        {duration !== "" && !durationValid ? <p className="hint hint-error">{t("plan.form.durationInvalid", { max: BLOCK_MAX_MINUTES })}</p> : null}
      </div>
      {overDates.map((o) => (
        <p key={o.date} className="notice notice-warn" data-testid="form-capacity-warning">
          {t("plan.form.overCapacity", { date: formatLocalDate(o.date, ctx, "medium"), planned: formatMinutes(t, o.planned), capacity: formatMinutes(t, ctx.capacity!) })}
        </p>
      ))}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" disabled={!ready}>
          {t("org.save")}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
    </form>
  );
}

/* ---------------- rows ---------------- */

export function BlockRow({ ctx, block, date, overlaps }: { ctx: PlanningContext; block: BlockItem; date: string; overlaps: boolean }) {
  const t = useT();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = blockLabel(block.data, ctx.tasks);
  const cancelled = block.data.status === "cancelled";
  const startDate = localDateOf(block.data.startsAt, ctx.zone);
  const endDate = localDateOf(Date.parse(block.data.endsAt) - 1, ctx.zone);
  if (editing) {
    return (
      <li className="item">
        <BlockForm ctx={ctx} mode={{ kind: "edit", block }} onDone={() => setEditing(false)} />
      </li>
    );
  }
  const time = `${formatTime(block.data.startsAt, ctx.zone, ctx.language)}–${formatTime(block.data.endsAt, ctx.zone, ctx.language)}`;
  const minutes = (Date.parse(block.data.endsAt) - Date.parse(block.data.startsAt)) / MINUTE_MS;
  async function toggle() {
    setError(null);
    try {
      await setBlockCancelled(db, block.id, !cancelled);
    } catch (e) {
      setError(planningError(t, e));
    }
  }
  return (
    <li className={`item block${cancelled ? " block-cancelled" : ""}`} data-testid="block-row">
      <div className="item-main">
        <span className="block-time">{time}</span> <span className="item-title">{label.title}</span>{" "}
        <span className="pill">{t("plan.planned")}</span>
        {cancelled ? <span className="pill pill-muted">{t("plan.cancelled")}</span> : null}
        {overlaps && !cancelled ? <span className="pill pill-warn">{t("plan.overlap")}</span> : null}
        <p className="hint">
          {formatMinutes(t, minutes)}
          {startDate !== date ? ` · ${t("plan.fromPreviousDay")}` : ""}
          {endDate !== date ? ` · ${t("plan.toNextDay")}` : ""}
          {block.data.occurrenceDate && block.data.occurrenceDate !== date
            ? ` · ${t("plan.forOccurrence", { date: formatLocalDate(block.data.occurrenceDate, ctx, "medium") })}`
            : ""}
          {label.fromSnapshot ? ` · ${t("plan.notOnDevice")}` : ""}
        </p>
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="button-row">
        {!cancelled ? (
          <button type="button" className="secondary" aria-label={t("plan.editLabel", { title: label.title })} onClick={() => setEditing(true)}>
            {t("org.edit")}
          </button>
        ) : null}
        <button type="button" className="secondary" aria-label={t(cancelled ? "plan.restoreLabel" : "plan.cancelLabel", { title: label.title })} onClick={toggle}>
          {t(cancelled ? "plan.restore" : "plan.cancel")}
        </button>
      </div>
    </li>
  );
}

export function UnscheduledRow({ ctx, item }: { ctx: PlanningContext; item: UnscheduledItem }) {
  const t = useT();
  const [scheduling, setScheduling] = useState(false);
  const task = ctx.tasks.get(item.taskId);
  if (!task) return null;
  if (scheduling) {
    return (
      <li className="item">
        <BlockForm ctx={ctx} mode={{ kind: "schedule", taskId: item.taskId, occurrenceDate: item.date }} onDone={() => setScheduling(false)} />
      </li>
    );
  }
  return (
    <li className="item unscheduled" data-testid="unscheduled-row">
      <div className="item-main">
        <span className="item-title">{task.title}</span> <span className="pill pill-muted">{t("plan.unscheduled")}</span>
        <p className="hint">{task.estimateMinutes !== null ? t("org.task.estimateShort", { minutes: task.estimateMinutes }) : t("plan.noEstimate")}</p>
      </div>
      <div className="button-row">
        <button type="button" aria-label={t("plan.scheduleLabel", { title: task.title })} onClick={() => setScheduling(true)}>
          {t("plan.schedule")}
        </button>
      </div>
    </li>
  );
}

/** Capacity of one date (D-021, T-031): informational only. */
export function CapacitySummary({ ctx, status, compact }: { ctx: PlanningContext; status: CapacityStatus; compact?: boolean }) {
  const t = useT();
  if (status.kind === "unset") {
    return compact ? null : <p className="hint" data-testid="capacity">{t("plan.capacity.unset", { planned: formatMinutes(t, status.planned) })}</p>;
  }
  const base = { planned: formatMinutes(t, status.planned), capacity: formatMinutes(t, status.capacity) };
  if (status.kind === "warning") {
    return (
      <p className="notice notice-warn" data-testid="capacity" data-capacity="warning">
        {t("plan.capacity.warning", { ...base, excess: formatMinutes(t, status.excess) })}
      </p>
    );
  }
  const noEstimate = status.noEstimate.map((id) => ctx.tasks.get(id)?.title ?? "").filter(Boolean).join(ctx.language === "fa" ? "، " : ", ");
  const noEstimateHint = noEstimate && !compact ? <p className="hint">{t("plan.capacity.noEstimate", { titles: noEstimate })}</p> : null;
  if (status.kind === "notice") {
    return (
      <div className="notice notice-info" data-testid="capacity" data-capacity="notice">
        <p>{t("plan.capacity.notice", { ...base, total: formatMinutes(t, status.withUnscheduled) })}</p>
        {noEstimateHint}
      </div>
    );
  }
  return (
    <div data-testid="capacity" data-capacity="ok">
      <p className="hint">{t("plan.capacity.ok", base)}</p>
      {noEstimateHint}
    </div>
  );
}

/** One date: its blocks in time order, its unscheduled items, and its capacity (day view, week view, Today). */
export function DayPanel({ ctx, plan, heading, headingLevel = 2 }: { ctx: PlanningContext; plan: DayPlan; heading?: string; headingLevel?: 2 | 3 }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="day-panel" aria-label={heading ?? formatLocalDate(plan.date, ctx)} data-testid="day-panel" data-date={plan.date}>
      <Heading>{heading ?? formatLocalDate(plan.date, ctx)}</Heading>
      <CapacitySummary ctx={ctx} status={plan.capacity} />
      {plan.blocks.length === 0 && plan.unscheduled.length === 0 ? <p className="muted">{t("plan.emptyDay")}</p> : null}
      {plan.blocks.length > 0 ? (
        <ul className="item-list" aria-label={t("plan.blocks")}>
          {overlapGroups(plan.blocks, plan.date, ctx.zone).map((group) =>
            group.length === 1 ? (
              <BlockRow key={group[0]!.id} ctx={ctx} block={group[0]!} date={plan.date} overlaps={plan.overlaps.has(group[0]!.id)} />
            ) : (
              // Overlapping blocks side by side (each also marked); neither is moved.
              <li key={group[0]!.id} className="overlap-group" data-testid="overlap-group">
                <ul className="overlap-row" aria-label={t("plan.overlapGroup", { count: group.length })}>
                  {group.map((block) => (
                    <BlockRow key={block.id} ctx={ctx} block={block} date={plan.date} overlaps={plan.overlaps.has(block.id)} />
                  ))}
                </ul>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {plan.unscheduled.length > 0 ? (
        <>
          <p className="hint">{t("plan.unscheduledHeading")}</p>
          <ul className="item-list" aria-label={t("plan.unscheduledHeading")}>
            {plan.unscheduled.map((item) => (
              <UnscheduledRow key={`${item.taskId}/${item.date}`} ctx={ctx} item={item} />
            ))}
          </ul>
        </>
      ) : null}
      {adding ? (
        <BlockForm ctx={ctx} mode={{ kind: "new", date: plan.date }} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="secondary" onClick={() => setAdding(true)} aria-label={t("plan.addLabel", { date: formatLocalDate(plan.date, ctx, "medium") })}>
          {t("plan.add")}
        </button>
      )}
    </section>
  );
}
