/**
 * Stage 3 follow-up — day and week time grid (PRODUCT_SPEC "Stage 3 follow-up"; DECISIONS T-066,
 * T-067, T-069, T-089). A tap or click on empty time pre-fills a 30-minute block; a drag across
 * empty time pre-fills that range; blocks move by drag and resize by their edges. Everything snaps
 * to 15 minutes of wall time in the configured zone. Creation always goes through the block form
 * (a task or quick-add title, then Save); moves and resizes are ordinary block edits.
 *
 * Mouse drags start after a small movement. Touch drags start after a long press, so a normal
 * swipe still scrolls the grid (or, sideways, changes the shown days on a phone). Every action is
 * also available without a pointer: blocks are buttons that open their row (edit, cancel,
 * restore), and each day has an Add button; the List layout stays available.
 */
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import { formatLocalDate, formatTime } from "../i18n/index.ts";
import { type BlockTimeInput, dragBlockTimes } from "../local/planning.ts";
import {
  DAY_MINUTES,
  type EditResult,
  type GridResult,
  isAmbiguousInstant,
  laneLayout,
  moveTarget,
  rangeSelection,
  resizeTarget,
  segmentPlacement,
  tapSelection,
  wallMinutesOf,
} from "../planning/grid.ts";
import { blockLabel, type BlockItem, filterBlocks, type PlanFilter } from "../planning/planning.ts";
import { formatOffset, localDateOf, MINUTE_MS, offsetMinutesAt } from "../planning/time.ts";
import { blockColor, dayPlan, formatMinutes, planningError, type PlanningContext } from "./planning-ui.tsx";
import type { UndoOffer } from "./UndoBar.tsx";

const HOUR_PX = 64;
const MOUSE_DRAG_PX = 4;
const TOUCH_SLOP_PX = 8;
const LONG_PRESS_MS = 400;
const SWIPE_PX = 50;
const FIRST_VISIBLE_HOUR = 7;

type Gesture =
  | { kind: "create"; date: string; startMinutes: number }
  | { kind: "move"; block: BlockItem; date: string; startMinutes: number }
  | { kind: "resize"; block: BlockItem; edge: "start" | "end" };

interface Pending {
  gesture: Gesture;
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  active: boolean; // a drag is in progress (after movement or a long press)
  timer: number | null;
}

interface Preview {
  date: string;
  top: number;
  bottom: number;
  /** Text inside the preview: start, length, and the offset of an ambiguous time (T-030); or why it is refused. */
  label: string;
  refused: boolean;
}

export function TimeGrid({
  ctx,
  dates,
  filter,
  onCreate,
  onOpenBlock,
  onAdd,
  onMoved,
  onError,
  onSwipe,
}: {
  ctx: PlanningContext;
  dates: string[];
  filter: PlanFilter;
  onCreate: (input: BlockTimeInput) => void;
  onOpenBlock: (block: BlockItem) => void;
  onAdd: (date: string) => void;
  onMoved: (offer: UndoOffer) => void;
  onError: (message: string) => void;
  onSwipe?: (direction: 1 | -1) => void;
}) {
  const t = useT();
  const { db } = useServices();
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef(new Map<string, HTMLDivElement>());
  const pending = useRef<Pending | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const shown = filterBlocks(ctx.blocks, filter, ctx.tasks);
  const rtl = ctx.language === "fa";

  // Start the view at the morning; the whole day stays reachable by scrolling.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX;
  }, []);

  // While a touch drag is active, stop the page from scrolling under the finger.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (pending.current?.active) e.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, []);

  function minutesAt(date: string, clientY: number): number {
    const rect = columns.current.get(date)!.getBoundingClientRect();
    return ((clientY - rect.top) / rect.height) * DAY_MINUTES;
  }

  /** The shown date under the pointer (nearest column), for moves across week columns. */
  function dateAt(clientX: number): string {
    let best = dates[0]!;
    let distance = Infinity;
    for (const date of dates) {
      const rect = columns.current.get(date)?.getBoundingClientRect();
      if (!rect) continue;
      const d = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      if (d < distance) [best, distance] = [date, d];
    }
    return best;
  }

  /** The selection (create) or the block's new times (move, resize) under the pointer. */
  function resultOf(g: Gesture, clientX: number, clientY: number): { result: GridResult | EditResult; date: string } {
    if (g.kind === "create") return { result: rangeSelection(g.date, g.startMinutes, minutesAt(g.date, clientY), ctx.zone), date: g.date };
    if (g.kind === "move") {
      const to = dateAt(clientX);
      const deltaDays = dates.indexOf(to) - dates.indexOf(g.date);
      return { result: moveTarget(g.block.data, deltaDays, minutesAt(g.date, clientY) - g.startMinutes, ctx.zone), date: to };
    }
    const date = dateAt(clientX);
    return { result: resizeTarget(g.block.data, g.edge, date, minutesAt(date, clientY), ctx.zone), date };
  }

  function evaluate(g: Gesture, clientX: number, clientY: number): Preview | null {
    const { result, date } = resultOf(g, clientX, clientY);
    if (result.kind === "unchanged") return null; // still where it was: nothing to show or write
    if (result.kind === "gap" || result.kind === "invalid") return { date, top: 0, bottom: 15, label: refusal(result), refused: true };
    if ("input" in result) {
      const [h, m] = result.input.startTime.split(":").map(Number) as [number, number];
      const top = h * 60 + m;
      const label = `${result.input.startTime} · ${formatMinutes(t, result.input.durationMinutes)}`;
      return { date: result.input.date, top, bottom: Math.min(DAY_MINUTES, top + result.input.durationMinutes), label, refused: false };
    }
    const top = wallMinutesOf(result.startsAt, ctx.zone);
    const minutes = (Date.parse(result.endsAt) - Date.parse(result.startsAt)) / MINUTE_MS;
    const time = formatTime(result.startsAt, ctx.zone, ctx.language);
    const label = `${result.ambiguous ? `${time} (${formatOffset(result.offsetMinutes)})` : time} · ${formatMinutes(t, minutes)}`;
    return { date: localDateOf(result.startsAt, ctx.zone), top, bottom: Math.min(DAY_MINUTES, top + minutes), label, refused: false };
  }

  function begin(event: ReactPointerEvent, gesture: Gesture) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const touch = event.pointerType !== "mouse";
    const p: Pending = { gesture, pointerId: event.pointerId, touch, x0: event.clientX, y0: event.clientY, active: false, timer: null };
    // Resize handles drag at once; other touch gestures wait for a long press.
    if (gesture.kind === "resize") activate(p);
    else if (touch) {
      p.timer = window.setTimeout(() => {
        if (pending.current === p) activate(p);
      }, LONG_PRESS_MS);
    }
    pending.current = p;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    if (gesture.kind === "resize") event.preventDefault();
  }

  function activate(p: Pending) {
    p.active = true;
    if (p.gesture.kind !== "create") setDraggingId(p.gesture.block.id);
    setPreview(evaluate(p.gesture, p.x0, p.y0));
    navigator.vibrate?.(10);
  }

  function move(event: ReactPointerEvent) {
    const p = pending.current;
    if (!p || p.pointerId !== event.pointerId) return;
    const dx = event.clientX - p.x0;
    const dy = event.clientY - p.y0;
    if (!p.active) {
      if (p.touch) {
        if (Math.hypot(dx, dy) > TOUCH_SLOP_PX) {
          // Not a long press: a sideways swipe on a phone changes the shown days; otherwise the browser scrolls.
          cancel();
          if (onSwipe && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) onSwipe((dx < 0) !== rtl ? 1 : -1);
        }
        return;
      }
      if (Math.hypot(dx, dy) < MOUSE_DRAG_PX) return;
      activate(p);
    }
    setPreview(evaluate(p.gesture, event.clientX, event.clientY));
  }

  async function end(event: ReactPointerEvent) {
    const p = pending.current;
    if (!p || p.pointerId !== event.pointerId) return;
    cancel();
    const g = p.gesture;
    if (!p.active) {
      // A tap or click without a drag.
      if (g.kind === "create") commitCreate(tapSelection(g.date, g.startMinutes, ctx.zone));
      else if (g.kind === "move") onOpenBlock(g.block);
      return;
    }
    const { result } = resultOf(g, event.clientX, event.clientY);
    if (g.kind === "create") commitCreate(result as GridResult);
    else await commitEdit(g.block, result as EditResult);
  }

  function cancel() {
    const p = pending.current;
    if (p?.timer) window.clearTimeout(p.timer);
    pending.current = null;
    setPreview(null);
    setDraggingId(null);
  }

  function refusal(result: { kind: "gap" | "invalid" }): string {
    return t(result.kind === "gap" ? "plan.error.DST_GAP" : "plan.error.INVALID_DURATION");
  }

  function commitCreate(result: GridResult) {
    if (result.kind === "ok") onCreate(result.input);
    else onError(refusal(result));
  }

  async function commitEdit(block: BlockItem, result: EditResult) {
    if (result.kind === "unchanged") return; // dropped where it was: no edit (the instant never shifts)
    if (result.kind !== "ok") {
      onError(refusal(result));
      return;
    }
    try {
      const { previous, after, previousVersion, version } = await dragBlockTimes(db, block.id, result);
      if (version) onMoved({ blockId: block.id, title: blockLabel(block.data, ctx.tasks).title, previous, after, previousVersion, version });
    } catch (e) {
      onError(planningError(t, e));
    }
  }

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const style = { "--hour-px": `${HOUR_PX}px`, "--grid-days": dates.length } as CSSProperties;

  return (
    <div className="time-grid" style={style} data-testid="time-grid" data-days={dates.length}>
      <div className="tg-header">
        <div className="tg-corner" aria-hidden="true" />
        {dates.map((date) => {
          const plan = dayPlan(ctx, date, filter);
          return (
            <div key={date} className="tg-day-head" data-date={date}>
              <span className="tg-day-name">{formatLocalDate(date, ctx, "medium")}</span>
              {plan.capacity.kind === "warning" ? <span className="pill pill-warn">{t("calendar.overCapacity")}</span> : null}
              {plan.unscheduled.length ? <span className="hint">{t("calendar.unscheduledCount", { count: plan.unscheduled.length })}</span> : null}
              <button type="button" className="secondary tg-add" aria-label={t("plan.addLabel", { date: formatLocalDate(date, ctx, "medium") })} onClick={() => onAdd(date)}>
                <span aria-hidden="true">+</span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body">
          <div className="tg-hours" aria-hidden="true">
            {hours.map((h) => (
              <span key={h} className="tg-hour">
                {formatTime(Date.UTC(2026, 0, 1, h), "UTC", ctx.language)}
              </span>
            ))}
          </div>
          {dates.map((date) => {
            const items = shown
              .map((block) => ({ block, place: segmentPlacement(block.data, date, ctx.zone) }))
              .filter((x): x is { block: BlockItem; place: NonNullable<ReturnType<typeof segmentPlacement>> } => x.place !== null);
            const lanes = laneLayout(items.map((x) => ({ id: x.block.id, top: x.place.top, bottom: x.place.bottom })));
            return (
              <div
                key={date}
                className="tg-column"
                data-date={date}
                data-testid="grid-column"
                ref={(el) => {
                  if (el) columns.current.set(date, el);
                  else columns.current.delete(date);
                }}
                onPointerDown={(e) => {
                  if ((e.target as Element).closest(".tg-block")) return;
                  begin(e, { kind: "create", date, startMinutes: minutesAt(date, e.clientY) });
                }}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={cancel}
              >
                {items.map(({ block, place }) => (
                  <GridBlock
                    key={block.id}
                    ctx={ctx}
                    block={block}
                    date={date}
                    place={place}
                    lane={lanes.get(block.id)!}
                    dragging={draggingId === block.id}
                    onPointerDown={(e, edge) => {
                      if (block.data.status !== "planned") return; // cancelled blocks are not dragged
                      e.stopPropagation();
                      begin(e, edge ? { kind: "resize", block, edge } : { kind: "move", block, date, startMinutes: minutesAt(date, e.clientY) });
                    }}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={cancel}
                    onOpen={() => onOpenBlock(block)}
                  />
                ))}
                {preview && preview.date === date ? (
                  <div
                    className={`tg-preview${preview.refused ? " tg-preview-refused" : ""}`}
                    data-testid="grid-preview"
                    style={{ top: `${(preview.top / DAY_MINUTES) * 100}%`, height: `${(Math.max(preview.bottom - preview.top, 15) / DAY_MINUTES) * 100}%` }}
                    aria-hidden="true"
                  >
                    {preview.label}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GridBlock({
  ctx,
  block,
  date,
  place,
  lane,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onOpen,
}: {
  ctx: PlanningContext;
  block: BlockItem;
  date: string;
  place: NonNullable<ReturnType<typeof segmentPlacement>>;
  lane: { lane: number; lanes: number };
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent, edge?: "start" | "end") => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  const label = blockLabel(block.data, ctx.tasks);
  const planned = block.data.status === "planned";
  // A time inside a repeated hour (clocks going back) shows its offset, so both occurrences are told apart (T-030).
  const clock = (instant: string) =>
    isAmbiguousInstant(instant, ctx.zone) ? `${formatTime(instant, ctx.zone, ctx.language)} (${formatOffset(offsetMinutesAt(instant, ctx.zone))})` : formatTime(instant, ctx.zone, ctx.language);
  const time = `${clock(block.data.startsAt)}–${clock(block.data.endsAt)}`;
  const minutes = (Date.parse(block.data.endsAt) - Date.parse(block.data.startsAt)) / MINUTE_MS;
  const status = planned ? t("plan.planned") : t("plan.cancelled");
  const style = {
    top: `${(place.top / DAY_MINUTES) * 100}%`,
    height: `${(Math.max(place.bottom - place.top, 15) / DAY_MINUTES) * 100}%`,
    insetInlineStart: `${(lane.lane / lane.lanes) * 100}%`,
    width: `${100 / lane.lanes}%`,
  } as CSSProperties;
  const handlers = { onPointerMove, onPointerUp, onPointerCancel };
  return (
    <div
      className={`tg-block colored${dragging ? " tg-dragging" : ""}`}
      style={style}
      data-color={blockColor(ctx, block.data)}
      data-status={block.data.status}
      data-testid="grid-block"
      data-block-id={block.id}
      data-date={date}
      onPointerDown={(e) => onPointerDown(e)}
      {...handlers}
    >
      {planned && place.startsHere ? <span className="tg-handle tg-handle-start" aria-hidden="true" onPointerDown={(e) => onPointerDown(e, "start")} {...handlers} /> : null}
      <button
        type="button"
        className="tg-block-button"
        aria-label={t("grid.blockLabel", { title: label.title, time, status, duration: formatMinutes(t, minutes) })}
        onClick={(e) => {
          // Pointer taps on a planned block are handled by the gesture code; this is the keyboard
          // path, and the only path for a cancelled block (which is never dragged).
          if (e.detail === 0 || !planned) onOpen();
        }}
      >
        <span className="tg-block-time">{time}</span> <span className="tg-block-title">{label.title}</span>{" "}
        <span className="tg-status">{status}</span>
      </button>
      {planned && place.endsHere ? <span className="tg-handle tg-handle-end" aria-hidden="true" onPointerDown={(e) => onPointerDown(e, "end")} {...handlers} /> : null}
    </div>
  );
}
