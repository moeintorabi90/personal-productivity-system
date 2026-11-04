// @vitest-environment jsdom
/**
 * Stage 6 interface (TESTING "Stage 6 acceptance tests" items 1, 2, 5, 6, 10, 11, 14, 17, 19):
 * Planned and Actual subcolumns with session segments, the confirmed drag correction, month cells,
 * the goal pace panel with allocations and moves, dashboards, reports, unit suggestions, and the
 * timer with its floating view by feature detection. English and Persian (RTL). Only `Date` is faked.
 */
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppServices, createServices, ServicesProvider } from "./app-context.tsx";
import { App } from "./App.tsx";
import { weekPlanId } from "./backup/derived-id.ts";
import {
  CORRECTIONS,
  GOAL_WEEK_ALLOCATIONS,
  GOAL_WEEK_PLANS,
  type GoalWeekAllocationData,
  type GoalWeekPlanData,
  MAIN_DASHBOARD_ID,
  PLAN_SEQ_MAX,
  PRODUCT_REGISTRY,
  SESSIONS,
  type SessionData,
} from "./backup/registry.ts";
import { createGoal } from "./local/goals.ts";
import { setWeekAllocation } from "./local/goal-plans.ts";
import { loadInsightRecords } from "./local/insights.ts";
import { createTask } from "./local/organization.ts";
import { envelopeFits, nowIso } from "./backup/envelope.ts";
import { deviceIdentity, plannedWriteEnvelope, putRecord, toEnvelope, updateDeviceSettings } from "./local/records.ts";
import { updateSharedPreferences } from "./local/settings.ts";
import { loadTimer } from "./local/timer.ts";
import { endSession, pauseSession, recordPastSession, resumeSession, startSession } from "./local/work.ts";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

let services: AppServices;
let dbCounter = 0;

async function renderApp(prepare?: (s: AppServices) => Promise<void>) {
  services = createServices({ dbName: `stage6-ui-${++dbCounter}`, apiBaseUrl: "http://127.0.0.1:9" });
  await updateSharedPreferences(services.db, { timeZone: "UTC", weekStart: 1 });
  if (prepare) await prepare(services);
  render(
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>,
  );
  await screen.findByRole("heading", { level: 1 });
}

const at = (iso: string) => vi.setSystemTime(new Date(iso));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-11-04T12:00:00Z"); // Wednesday
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
  document.documentElement.removeAttribute("dir");
});
afterEach(async () => {
  cleanup();
  await services.engine.stop();
  services.db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const goTo = async (name: string) => fireEvent.click(await screen.findByRole("button", { name }));

describe("1–2. calendar: Planned and Actual subcolumns, segments, drag correction (T-072, T-174 to T-177)", () => {
  async function withPausedSession() {
    await renderApp(async (s) => {
      at("2026-11-04T08:00:00Z");
      const id = await startSession(s.db);
      for (const [p, r] of [["08:20", "08:30"], ["08:50", "09:00"]]) {
        at(`2026-11-04T${p}:00Z`);
        await pauseSession(s.db, id);
        at(`2026-11-04T${r}:00Z`);
        await resumeSession(s.db, id);
      }
      at("2026-11-04T09:30:00Z");
      await endSession(s.db, id);
      at("2026-11-04T12:00:00Z");
    });
    await goTo("Calendar");
    return await screen.findByTestId("grid-week-view");
  }

  it("each day header of the week view shows the full local weekday name with its date (T-241), in English and Persian", async () => {
    await renderApp();
    await goTo("Calendar");
    const week = await screen.findByTestId("grid-week-view");
    const head = (date: string) => week.querySelector(`.tg-day-head[data-date="${date}"] .tg-day-name`)!.textContent;
    expect(head("2026-11-04")).toMatch(/^Wednesday · /);
    expect(head("2026-11-08")).toMatch(/^Sunday · /);
    cleanup();
    await services.engine.stop();
    services.db.close();
    await renderApp(async (s) => updateDeviceSettings(s.db, { language: "fa" }));
    await goTo("تقویم");
    const weekFa = await screen.findByTestId("grid-week-view");
    await waitFor(() => expect(weekFa.querySelector('.tg-day-head[data-date="2026-11-04"] .tg-day-name')!.textContent).toMatch(/^چهارشنبه، /));
    expect(weekFa.querySelector('.tg-day-head[data-date="2026-11-04"] .tg-day-name')!.textContent).not.toContain("·");
  });

  it("a session with two pauses shows three segments and gaps in the Actual subcolumn and acts as one session", async () => {
    const week = await withPausedSession();
    expect(within(week).getAllByText("Planned").length).toBeGreaterThan(0);
    const session = await within(week).findByTestId("grid-session");
    expect(session.dataset.segments).toBe("3");
    expect(within(session).getAllByTestId("grid-segment")).toHaveLength(3);
    const button = within(session).getByRole("button");
    expect(button.getAttribute("aria-label")).toMatch(/^Actual: No task, .*3 work segment/);
    fireEvent.click(button, { detail: 0 }); // keyboard path opens the one session
    expect(await screen.findByTestId("opened-session")).toBeTruthy();
  });

  it("dropping a session asks first: cancel writes nothing; confirm keeps the record and adds a correction", async () => {
    const week = await withPausedSession();
    const session = await within(week).findByTestId("grid-session");
    const sessionId = session.dataset.sessionId!;
    const column = session.closest<HTMLElement>('[data-testid="grid-column"]')!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "grid-column") {
        const columns = [...document.querySelectorAll<HTMLElement>('[data-testid="grid-column"]')];
        const left = columns.indexOf(this) * 100;
        return { top: 0, bottom: 1536, height: 1536, left, right: left + 100, width: 100, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    if (!("PointerEvent" in window)) {
      class PointerEventPolyfill extends MouseEvent {
        pointerId = 1;
        pointerType = "mouse";
      }
      vi.stubGlobal("PointerEvent", PointerEventPolyfill);
    }
    const left = [...document.querySelectorAll('[data-testid="grid-column"]')].indexOf(column) * 100;
    const p = (y: number) => ({ clientX: left + 75, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, bubbles: true });
    const before = (await services.db.records.get([SESSIONS, sessionId]))!.data as SessionData;
    fireEvent.pointerDown(session, p(8 * 64 + 20));
    fireEvent.pointerMove(session, p(6 * 64 + 20));
    fireEvent.pointerUp(session, p(6 * 64 + 20));
    const dialog = await screen.findByTestId("session-move-confirm");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect((await services.db.records.get([SESSIONS, sessionId]))!.data).toEqual(before);
    fireEvent.pointerDown(session, p(8 * 64 + 20));
    fireEvent.pointerMove(session, p(6 * 64 + 20));
    fireEvent.pointerUp(session, p(6 * 64 + 20));
    const again = await screen.findByTestId("session-move-confirm");
    fireEvent.change(within(again).getByLabelText("Reason (optional)"), { target: { value: "forgot to start" } });
    fireEvent.click(within(again).getByRole("button", { name: "Confirm correction" }));
    await waitFor(async () => expect(((await services.db.records.get([SESSIONS, sessionId]))!.data as SessionData).startedAt).toBe("2026-11-04T06:00:00.000Z"));
    const corrections = await services.db.records.where("type").equals(CORRECTIONS).toArray();
    expect(corrections.map((c) => c.data)).toEqual([expect.objectContaining({ sessionId, field: "times", reason: "forgot to start" })]);
  });

  it("a month cell shows planned and actual work together, with a non-color cue", async () => {
    await withPausedSession();
    fireEvent.change(screen.getByLabelText("View"), { target: { value: "month" } });
    const cell = (await screen.findByTestId("month-view")).querySelector('[data-date="2026-11-04"]') as HTMLElement;
    expect(within(cell).getByTestId("month-actual").textContent).toBe("1 actual");
    expect(within(cell).getByRole("button").getAttribute("aria-label")).toMatch(/1 actual/);
  });
});

describe("5, 6, 17. goal pace, allocations, moves, streaks (T-181 to T-186, T-206, T-218, T-220)", () => {
  async function goal(patch = {}) {
    let goalId = "";
    await renderApp(async (s) => {
      at("2026-11-02T08:00:00Z");
      goalId = await createGoal(s.db, { name: "Pages", startDate: "2026-11-02", deadline: "2026-11-29", kind: "taskCount", target: 600, workdays: [1, 2, 3, 4, 5], ...patch });
    });
    await goTo("Goals");
    fireEvent.click(await screen.findByRole("button", { name: "Open goal: Pages" }));
    await screen.findByTestId("goal-pace");
    return goalId;
  }

  it("a stored plan date whose entries cover one another shows a data-integrity warning, keeps this device's plan, and can be settled (Codex review)", async () => {
    const goalId = await goal();
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toBe("30"));
    const planId = weekPlanId(goalId, "2026-11-02");
    const plan = (await services.db.records.get([GOAL_WEEK_PLANS, planId]))!.data as GoalWeekPlanData;
    const own = plan.dates[0]!.entries[0]!;
    const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const theirs = { state: "allocated" as const, allocation: { num: 100, den: 1 }, source: "manual" as const };
    // Written as malformed data may have arrived before this check existed.
    await putRecord(services.db, PRODUCT_REGISTRY, GOAL_WEEK_PLANS, planId, {
      ...plan,
      dates: [{ ...plan.dates[0]!, entries: [{ ...own, seen: { [other]: 1 } }, { device: other, seq: 1, seen: { [own.device]: own.seq }, segment: theirs }].sort((p, q) => (p.device < q.device ? -1 : 1)) }],
    });
    const warning = await screen.findByTestId("plan-conflict");
    expect(warning.dataset.kind).toBe("inconsistent");
    expect(warning.textContent).toMatch(/^Data integrity issue: .*This device's version applies until you choose\.$/);
    expect(screen.getByTestId("today-target").textContent).toBe("30"); // the plan is not hidden
    const decide = screen.getByTestId("decide");
    expect(within(decide).getAllByRole("button", { name: "Choose" })).toHaveLength(2);
    const row = within(decide).getAllByRole("listitem").find((li) => li.textContent!.startsWith("100"))!;
    fireEvent.click(within(row).getByRole("button", { name: "Choose" }));
    fireEvent.click(within(await screen.findByTestId("confirm-choice")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByTestId("plan-conflict")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toBe("20")); // 100 over 5 workdays
  });

  it("when this device's counter for such a date is claimed at the maximum, the view says no choice can be recorded here and offers none (Codex review)", async () => {
    const goalId = await goal();
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toBe("30"));
    const planId = weekPlanId(goalId, "2026-11-02");
    const plan = (await services.db.records.get([GOAL_WEEK_PLANS, planId]))!.data as GoalWeekPlanData;
    const own = plan.dates[0]!.entries[0]!;
    const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const theirs = { state: "allocated" as const, allocation: { num: 100, den: 1 }, source: "manual" as const };
    await putRecord(services.db, PRODUCT_REGISTRY, GOAL_WEEK_PLANS, planId, {
      ...plan,
      dates: [{ ...plan.dates[0]!, entries: [{ ...own, seen: { [other]: 1 } }, { device: other, seq: 1, seen: { [own.device]: PLAN_SEQ_MAX }, segment: theirs }].sort((p, q) => (p.device < q.device ? -1 : 1)) }],
    });
    expect((await screen.findByTestId("plan-conflict")).dataset.kind).toBe("inconsistent");
    expect((await screen.findByTestId("decision-blocked")).textContent).toMatch(/^This device cannot record a choice for this date/);
    expect(screen.queryByTestId("decide")).toBeNull();
    expect(screen.getByTestId("today-target").textContent).toBe("30"); // this device's plan still applies
  });

  it("a plan change that cannot be recorded because today's counter is at the maximum shows a warning and keeps the recorded plan; otherwise no warning (Codex review)", async () => {
    // The counter is set to the maximum before the app first renders, so the goal page never shows an
    // earlier version of the record and the checks below cannot run against a stale render.
    let goalId = "";
    await renderApp(async (s) => {
      at("2026-11-02T08:00:00Z");
      goalId = await createGoal(s.db, { name: "Pages", startDate: "2026-11-02", deadline: "2026-11-29", kind: "taskCount", target: 600, workdays: [1, 2, 3, 4, 5] });
      const id = weekPlanId(goalId, "2026-11-02");
      const plan = (await s.db.records.get([GOAL_WEEK_PLANS, id]))!.data as GoalWeekPlanData;
      // Well-formed data whose counter for today is at the maximum.
      await putRecord(s.db, PRODUCT_REGISTRY, GOAL_WEEK_PLANS, id, { ...plan, dates: [{ ...plan.dates[0]!, entries: [{ ...plan.dates[0]!.entries[0]!, seq: PLAN_SEQ_MAX }] }] });
    });
    const planId = weekPlanId(goalId, "2026-11-02");
    const recorded = async () => (await services.db.records.get([GOAL_WEEK_PLANS, planId]))!;
    const before = await recorded();
    const entries = (before.data as GoalWeekPlanData).dates.flatMap((d) => d.entries);
    expect(entries.map((e) => e.seq)).toEqual([PLAN_SEQ_MAX]); // the stored record really is at the maximum
    await goTo("Goals");
    fireEvent.click(await screen.findByRole("button", { name: "Open goal: Pages" }));
    await screen.findByTestId("goal-pace");
    // Today's target comes from the recorded plan, so it appears only once the page has loaded that record.
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toBe("30"));
    expect(screen.getByTestId("plan-date").dataset.from).toBe("2026-11-02");
    expect(await recorded()).toEqual(before); // opening the page wrote nothing
    expect(screen.queryByTestId("plan-not-updated")).toBeNull(); // at the maximum, but the plan is unchanged: no warning
    // 300 in the next week leaves 100 for this one: today's computed plan changes, but cannot be written.
    await setWeekAllocation(services.db, goalId, "2026-11-09", 300);
    const warning = await screen.findByTestId("plan-not-updated");
    expect(warning.textContent).toMatch(/^Today's plan changed, but it could not be recorded on this device: .*comes from the last recorded plan\./);
    expect(await recorded()).toEqual(before); // the recorded plan is not rewritten
    expect(screen.getByTestId("today-target").textContent).toBe("30"); // still the recorded plan's target
    expect(screen.queryByTestId("plan-conflict")).toBeNull();
  });

  it("a plan change that would make the week's record pass the size limit is not written, and the goal page says so (owner, 2026-11-04)", async () => {
    // Written before the first render: Monday's settled entry with as many earlier options as still fit.
    let goalId = "";
    await renderApp(async (s) => {
      at("2026-11-02T08:00:00Z");
      goalId = await createGoal(s.db, { name: "Pages", startDate: "2026-11-02", deadline: "2026-11-29", kind: "taskCount", target: 600, workdays: [1, 2, 3, 4, 5] });
      const id = weekPlanId(goalId, "2026-11-02");
      const row = (await s.db.records.get([GOAL_WEEK_PLANS, id]))!;
      const plan = row.data as GoalWeekPlanData;
      const device = (await deviceIdentity(s.db)).id;
      const fits = (data: GoalWeekPlanData) => envelopeFits(plannedWriteEnvelope(row, id, data as unknown as Record<string, unknown>, device, nowIso()));
      const withOptions = (n: number): GoalWeekPlanData => ({
        ...plan,
        dates: [{ ...plan.dates[0]!, options: Array.from({ length: n }, (_, i) => ({ state: "allocated" as const, allocation: { num: 100_000 + i, den: 1 }, source: "manual" as const })) }],
      });
      let low = 0;
      let high = 10_000;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(withOptions(mid))) low = mid;
        else high = mid - 1;
      }
      await putRecord(s.db, PRODUCT_REGISTRY, GOAL_WEEK_PLANS, id, withOptions(low));
      at("2026-11-03T08:00:00Z"); // Tuesday: a plan change would add a new date to the record
    });
    const planId = weekPlanId(goalId, "2026-11-02");
    const recorded = async () => (await services.db.records.get([GOAL_WEEK_PLANS, planId]))!;
    const before = await recorded();
    expect(envelopeFits(toEnvelope(before))).toBe(true);
    await goTo("Goals");
    fireEvent.click(await screen.findByRole("button", { name: "Open goal: Pages" }));
    await screen.findByTestId("goal-pace");
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toMatch(/^\d/));
    const target = screen.getByTestId("today-target").textContent;
    expect(screen.queryByTestId("plan-not-updated")).toBeNull(); // nothing to update yet: no warning
    await setWeekAllocation(services.db, goalId, "2026-11-09", 300);
    const warning = await screen.findByTestId("plan-not-updated", undefined, { timeout: 15_000 }); // thousands of options render slowly in jsdom
    expect(warning.dataset.reason).toBe("size");
    expect(warning.textContent).toMatch(/^Today's plan changed, but it could not be recorded on this device: this week's plan would become larger than a backup record may be\./);
    expect(await recorded()).toEqual(before); // not written, and no option removed
    expect(screen.getByTestId("today-target").textContent).toBe(target); // still from the last recorded plan
  }, 30_000);

  it("the same plan change with a counter below the maximum is recorded, with no warning", async () => {
    const goalId = await goal();
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toBe("30"));
    await setWeekAllocation(services.db, goalId, "2026-11-09", 300);
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toBe("20")); // 100 over 5 workdays
    expect(screen.queryByTestId("plan-not-updated")).toBeNull();
  });

  it("shows today's target from the recorded plan, the week's and month's targets, and both streaks by default", async () => {
    await goal();
    await waitFor(() => expect(screen.getByTestId("today-target").textContent).toBe("30")); // 150 for the week over 5 workdays
    expect(screen.getByTestId("week-target").textContent).toMatch(/^0 of 150/);
    expect(screen.getByTestId("goal-streaks").textContent).toMatch(/Consistency: 0 in a row/);
    expect(screen.getAllByTestId("allocation-row").map((r) => r.dataset.week)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
  });

  it("a manual week keeps its amount and the others are rebalanced; moving onto a manual week asks replace, add, or cancel", async () => {
    const goalId = await goal();
    // Rows appear once the live queries have loaded.
    const row = (week: string) =>
      waitFor(() => {
        const found = screen.getAllByTestId("allocation-row").find((r) => r.dataset.week === week);
        if (!found) throw new Error(`no row for ${week}`);
        return found;
      });
    fireEvent.change(within(await row("2026-11-09")).getByLabelText(/Manual amount/), { target: { value: "200" } });
    fireEvent.click(within(await row("2026-11-09")).getByRole("button", { name: "Set" }));
    await waitFor(async () => expect((await row("2026-11-16")).textContent).toMatch(/133\.33/));
    await setWeekAllocation(services.db, goalId, "2026-11-16", 150);
    fireEvent.click(await within(await row("2026-11-09")).findByRole("button", { name: "Move…" }));
    const dialog = await screen.findByTestId("move-allocation");
    fireEvent.change(within(dialog).getByLabelText("To the week of"), { target: { value: "2026-11-16" } });
    expect(await within(dialog).findByTestId("move-choice")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const amounts = async () => (await services.db.records.where("type").equals(GOAL_WEEK_ALLOCATIONS).toArray()).map((r) => [r.data.weekStart, (r.data as GoalWeekAllocationData).revisions.at(-1)!.amount]).sort();
    expect(await amounts()).toEqual([["2026-11-09", 200], ["2026-11-16", 150]]);
    fireEvent.click(await within(await row("2026-11-09")).findByRole("button", { name: "Move…" }));
    const second = await screen.findByTestId("move-allocation");
    fireEvent.change(within(second).getByLabelText("To the week of"), { target: { value: "2026-11-16" } });
    fireEvent.click(await within(second).findByRole("button", { name: "Add the two" }));
    await waitFor(async () => expect(await amounts()).toEqual([["2026-11-09", null], ["2026-11-16", 350]]));
  });

  it("weeks 1–3 manual at 250 show the mismatch, hide the targets, and keep progress; with a cap the unreachable warning is shown separately", async () => {
    const goalId = await goal({ dailyCap: 20 });
    for (const w of ["2026-11-02", "2026-11-09", "2026-11-16"]) await setWeekAllocation(services.db, goalId, w, 250);
    expect((await screen.findByTestId("mismatch-warning")).textContent).toMatch(/150 is out of balance/);
    expect(screen.getByTestId("month-target").textContent).toBe("No target");
    expect(screen.getByTestId("goal-progress").textContent).toMatch(/0 of 600/);
    expect(screen.getByTestId("cap-warning").textContent).toMatch(/at most 400 of 600/); // 20 workdays left × 20
  });
});

describe("11. dashboards (T-197 to T-202)", () => {
  it("the main dashboard starts with the suggested layout, app-use streak first; cards can be added, reordered, resized, and removed, and are saved", async () => {
    await renderApp();
    await goTo("Dashboard");
    const grid = await screen.findByTestId("dash-grid");
    await waitFor(() => expect(within(grid).getAllByTestId("dash-card")[0]!.dataset.metric).toBe("appUseStreak"));
    expect(within(grid).getByTestId("metric-appUseStreak").textContent).toMatch(/1 day/); // this visit counts (T-203)
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    const add = await screen.findByTestId("add-card");
    fireEvent.change(within(add).getByLabelText("Metric"), { target: { value: "completions" } });
    fireEvent.change(within(add).getByLabelText("Size"), { target: { value: "large" } });
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(async () => expect(((await loadInsightRecords(services.db)).dashboards.find((d) => d.id === MAIN_DASHBOARD_ID)?.data.cards ?? []).length).toBe(7));
    fireEvent.click(screen.getByRole("button", { name: "Move App-use streak later" }));
    await waitFor(async () => expect((await loadInsightRecords(services.db)).dashboards[0]!.data.cards[1]!.metric).toBe("appUseStreak"));
    const first = await waitFor(() => {
      const card = within(screen.getByTestId("dash-grid")).getAllByTestId("dash-card")[0]!;
      if (card.dataset.metric !== "completions") throw new Error("the moved order is not shown yet");
      return card;
    });
    fireEvent.change(within(first).getByLabelText("Size"), { target: { value: "large" } });
    await waitFor(async () => expect((await loadInsightRecords(services.db)).dashboards[0]!.data.cards[0]!.size).toBe("large"));
    const cards = async () => (await loadInsightRecords(services.db)).dashboards[0]!.data.cards;
    const before = (await cards()).length;
    fireEvent.click(within(screen.getByTestId("dash-grid")).getAllByRole("button", { name: "Remove Output rate" })[0]!);
    await waitFor(async () => expect((await cards()).length).toBe(before - 1));
    expect((await cards()).some((c) => c.metric === "outputRate")).toBe(false);
  });

  it("an optional dashboard can be created and deleted; the main one cannot be deleted", async () => {
    await renderApp();
    await goTo("Dashboard");
    fireEvent.change(await screen.findByLabelText("New dashboard"), { target: { value: "Study" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Study" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    vi.stubGlobal("confirm", () => true);
    fireEvent.click(screen.getByRole("button", { name: "Delete dashboard" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Main" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    expect(screen.queryByRole("button", { name: "Delete dashboard" })).toBeNull();
  });
});

describe("9–10. reports and units (T-192 to T-196)", () => {
  it("shows no data apart from a real zero, sample counts, and the metric dictionary", async () => {
    await renderApp(async (s) => {
      const task = await createTask(s.db, { title: "Essay" });
      at("2026-11-03T12:00:00Z");
      await recordPastSession(s.db, { date: "2026-11-03", startTime: "08:00", durationMinutes: 45, taskId: task });
      await recordPastSession(s.db, { date: "2026-11-03", startTime: "10:00", durationMinutes: 15 });
      at("2026-11-04T12:00:00Z");
    });
    await goTo("Reports");
    const work = (await screen.findAllByTestId("metric-workTime"))[0]!;
    expect(work.textContent).toMatch(/1 h/);
    expect(work.textContent).toMatch(/sample: 2/);
    expect(work.textContent).toMatch(/No task: 15 min/);
    expect(screen.getAllByTestId("no-data").length).toBeGreaterThan(0); // e.g. output rate with no outputs
    expect(screen.getByTestId("metric-dictionary").textContent).toMatch(/a recorded 0 counts/);
  });

  it("unit suggestions fill the definition form and a custom unit is still accepted", async () => {
    await renderApp();
    await goTo("Work");
    const chips = await screen.findByTestId("unit-suggestions");
    fireEvent.click(within(chips).getByRole("button", { name: "page" }));
    expect((screen.getAllByLabelText("Unit")[0] as HTMLInputElement).value).toBe("page");
    fireEvent.change(screen.getAllByLabelText("Unit")[0]!, { target: { value: "sketches" } });
    expect((screen.getAllByLabelText("Unit")[0] as HTMLInputElement).value).toBe("sketches");
  });
});

describe("19. timer (T-230 to T-240)", () => {
  it("without Document Picture-in-Picture there is no floating control; the stopwatch runs without a session; the selection is remembered", async () => {
    await renderApp();
    const bar = await screen.findByTestId("timer-bar");
    expect(within(bar).queryByTestId("open-floating")).toBeNull();
    fireEvent.click(within(bar).getByRole("tab", { name: "Stopwatch" }));
    await waitFor(async () => expect((await loadTimer(services.db)).selected).toBe("stopwatch"));
    fireEvent.click(await within(bar).findByRole("button", { name: "Start" }));
    await waitFor(async () => expect((await loadTimer(services.db)).stopwatch.status).toBe("running"));
    expect(await services.db.records.where("type").equals(SESSIONS).count()).toBe(0);
  });

  it("with the API present, the floating control opens one window that shows the same selected timer and acts on it only", async () => {
    // A test window standing in for the browser's floating window (provided by the test, whatever the browser).
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const pipWindow = frame.contentWindow!;
    const pipDoc = pipWindow.document;
    const requestWindow = vi.fn(async () => pipWindow);
    vi.stubGlobal("documentPictureInPicture", { requestWindow });
    await renderApp(async (s) => {
      await startSession(s.db);
    });
    const bar = await screen.findByTestId("timer-bar");
    fireEvent.click(await within(bar).findByTestId("open-floating"));
    await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(1));
    const floating = await waitFor(() => {
      const el = pipDoc.querySelector('[data-testid="timer-view-floating"]');
      if (!el) throw new Error("not yet");
      return el as HTMLElement;
    });
    expect(floating.dataset.selected).toBe("session");
    const pause = within(floating).getByRole("button", { name: "Pause" });
    fireEvent.click(pause);
    await waitFor(async () => {
      const s = (await services.db.records.where("type").equals(SESSIONS).toArray())[0]!.data as SessionData;
      expect(s.pauses).toHaveLength(1);
      expect(s.endedAt).toBeNull(); // pausing never ends the session
    });
    const stopwatch = await loadTimer(services.db);
    expect(stopwatch.stopwatch.status).toBe("idle"); // the floating view did not start a second timer
  });

  /**
   * A test window standing in for the floating window, stubbed before the app renders. Its own
   * viewport size is set by the test, separately from the main window's (T-238).
   */
  function testFloatingWindow() {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const pipWindow = frame.contentWindow!;
    vi.stubGlobal("documentPictureInPicture", { requestWindow: vi.fn(async () => pipWindow) });
    const current = () => pipWindow.document.querySelector('[data-testid="timer-view-floating"]') as HTMLElement | null;
    return {
      resize(width: number, height: number) {
        Object.defineProperty(pipWindow, "innerWidth", { value: width, configurable: true });
        Object.defineProperty(pipWindow, "innerHeight", { value: height, configurable: true });
        fireEvent(pipWindow, new (pipWindow as unknown as typeof globalThis).Event("resize"));
      },
      view: () =>
        waitFor(() => {
          const el = current();
          if (!el) throw new Error("not open yet");
          return el;
        }),
      current: () => current()!,
      buttons: () => within(current()!).queryAllByRole("button").map((b) => b.textContent),
    };
  }
  const valueOf = (el: HTMLElement) => within(el).getByTestId("timer-value").textContent;

  it("the floating window's own size switches it between the compact and the full view; the main window and the selection stay as they are (T-238)", async () => {
    const f = testFloatingWindow();
    await renderApp();
    const bar = await screen.findByTestId("timer-bar");
    fireEvent.click(within(bar).getByRole("tab", { name: "Stopwatch" }));
    await waitFor(() => expect(within(bar).getByRole("tab", { name: "Stopwatch" }).getAttribute("aria-selected")).toBe("true"));
    f.resize(340, 300);
    fireEvent.click(await within(bar).findByTestId("open-floating"));
    const full = await f.view();
    expect(full.dataset.compact).toBeUndefined();
    expect(within(full).getAllByRole("tab")).toHaveLength(3);
    expect(within(full).getByRole("button", { name: "Reset" })).toBeTruthy();

    f.resize(220, 140);
    await waitFor(() => expect(f.current().dataset.compact).toBe("true"));
    const compact = f.current();
    expect(compact.dataset.selected).toBe("stopwatch");
    expect(within(compact).queryAllByRole("tab")).toHaveLength(0); // no timer selector
    expect(f.buttons()).toEqual(["Start"]); // no Reset or other secondary control
    expect(compact.querySelector(".hint")).toBeNull(); // no explanatory text
    expect(within(compact).queryByTestId("timer-status")).toBeNull();
    expect(valueOf(compact)).toBe("0:00");
    const inApp = within(bar).getByTestId("timer-view");
    expect(within(inApp).getAllByRole("tab")).toHaveLength(3); // the main window keeps its full view
    expect(within(inApp).getByRole("button", { name: "Reset" })).toBeTruthy();

    // Start, Pause, and Resume from the compact view act on the selected stopwatch only.
    fireEvent.click(within(compact).getByRole("button", { name: "Start" }));
    await waitFor(async () => expect((await loadTimer(services.db)).stopwatch.status).toBe("running"));
    await waitFor(() => expect(f.buttons()).toEqual(["Pause"]));
    at("2026-11-04T12:01:05Z");
    await waitFor(() => expect(valueOf(f.current())).toBe("1:05"), { timeout: 3000 });
    expect(valueOf(within(bar).getByTestId("timer-view"))).toBe("1:05"); // the same time in both views
    fireEvent.click(within(f.current()).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(f.buttons()).toEqual(["Resume"]));
    expect((await loadTimer(services.db)).stopwatch).toMatchObject({ status: "paused", accumulatedMs: 65_000 });
    expect(within(bar).getByTestId("timer-status").textContent).toBe("Paused");
    fireEvent.click(within(f.current()).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(f.buttons()).toEqual(["Pause"]));

    // The main window's size does not make the floating window compact, and enlarging it brings the full view back.
    const mainWidth = window.innerWidth;
    try {
      f.resize(340, 300);
      await waitFor(() => expect(f.current().dataset.compact).toBeUndefined());
      Object.defineProperty(window, "innerWidth", { value: 200, configurable: true });
      fireEvent(window, new Event("resize"));
      expect(f.current().dataset.compact).toBeUndefined();
      expect(within(f.current()).getAllByRole("tab")).toHaveLength(3);
      expect(within(f.current()).getByRole("tab", { name: "Stopwatch" }).getAttribute("aria-selected")).toBe("true");
      expect(within(f.current()).getByRole("button", { name: "Reset" })).toBeTruthy();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: mainWidth, configurable: true });
    }
    const after = await loadTimer(services.db);
    expect(after.selected).toBe("stopwatch"); // resizing changed neither the selection nor the timer
    expect(after.stopwatch.status).toBe("running");
    expect(await services.db.records.where("type").equals(SESSIONS).count()).toBe(0);
  });

  it("the compact view pauses and resumes the work session and starts and pauses the countdown, in step with the main view (T-238)", async () => {
    const f = testFloatingWindow();
    await renderApp(async (s) => {
      await startSession(s.db);
    });
    const bar = await screen.findByTestId("timer-bar");
    f.resize(220, 140);
    fireEvent.click(await within(bar).findByTestId("open-floating"));
    await f.view();
    await waitFor(() => expect(f.current().dataset.compact).toBe("true"));
    expect(f.current().dataset.selected).toBe("session");
    expect(f.buttons()).toEqual(["Pause"]); // no End session in the compact view
    at("2026-11-04T12:02:00Z");
    await waitFor(() => expect(valueOf(f.current())).toBe("2:00"), { timeout: 3000 });
    expect(valueOf(within(bar).getByTestId("timer-view"))).toBe("2:00");
    fireEvent.click(within(f.current()).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(f.buttons()).toEqual(["Resume"]));
    const session = async () => (await services.db.records.where("type").equals(SESSIONS).toArray())[0]!.data as SessionData;
    expect((await session()).pauses).toHaveLength(1);
    expect(within(bar).getByRole("button", { name: "Resume" })).toBeTruthy(); // the main view shows the same state
    fireEvent.click(within(f.current()).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(f.buttons()).toEqual(["Pause"]));
    expect((await session()).endedAt).toBeNull();

    // Selecting the countdown in the main window changes the compact view to it.
    fireEvent.click(within(bar).getByRole("tab", { name: "Countdown" }));
    await waitFor(() => expect(f.current().dataset.selected).toBe("countdown"));
    expect(f.buttons()).toEqual(["Start"]); // no length fields, Reset, or sound setting
    expect(within(f.current()).queryByRole("checkbox")).toBeNull();
    expect(within(f.current()).queryByRole("textbox")).toBeNull();
    expect(valueOf(f.current())).toBe("25:00");
    fireEvent.click(within(f.current()).getByRole("button", { name: "Start" }));
    await waitFor(async () => expect((await loadTimer(services.db)).countdown).toMatchObject({ status: "running", durationMs: 25 * 60_000 }));
    await waitFor(() => expect(f.buttons()).toEqual(["Pause"]));
    fireEvent.click(within(f.current()).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(f.buttons()).toEqual(["Resume"]));
    expect(within(bar).getByTestId("timer-status").textContent).toBe("Paused");
    expect(valueOf(within(bar).getByTestId("timer-view"))).toBe(valueOf(f.current()));
    expect((await session()).pauses).toHaveLength(1); // the countdown did not touch the session
  });

  it("with no session open, both views show the Persian message, and the compact view starts nothing", async () => {
    const f = testFloatingWindow();
    await renderApp(async (s) => updateDeviceSettings(s.db, { language: "fa" }));
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    const bar = await screen.findByTestId("timer-bar");
    const message = "هیچ جلسهٔ کاری باز نیست.";
    // Each view shows the default language until its preferences load, so wait for the translation.
    await waitFor(() => expect(within(bar).getByTestId("session-timer-empty").textContent).toContain(message));
    await waitFor(() => expect(bar.querySelector("summary")!.textContent).toContain(message));
    f.resize(340, 300);
    fireEvent.click(await within(bar).findByTestId("open-floating"));
    await f.view();
    await waitFor(() => expect(within(f.current()).getByTestId("session-timer-empty").textContent).toBe(message));
    f.resize(220, 140);
    await waitFor(() => expect(f.current().dataset.compact).toBe("true"));
    expect(within(f.current()).getByTestId("session-timer-empty").textContent).toBe(message);
    expect(f.buttons()).toEqual([]); // nothing to start a session from here
    expect(await services.db.records.where("type").equals(SESSIONS).count()).toBe(0);
  });

  it("the countdown length is set in hours, minutes, and seconds, checked, and kept apart from a running or paused countdown (T-239)", async () => {
    await renderApp();
    const bar = await screen.findByTestId("timer-bar");
    fireEvent.click(within(bar).getByRole("tab", { name: "Countdown" }));
    const field = (name: string) => within(bar).getByLabelText(name) as HTMLInputElement;
    await waitFor(() => expect(field("Minutes").value).toBe("25"));
    expect([field("Hours").value, field("Seconds").value]).toEqual(["0", "0"]);
    const set = (h: string, m: string, s: string) => {
      fireEvent.change(field("Hours"), { target: { value: h } });
      fireEvent.change(field("Minutes"), { target: { value: m } });
      fireEvent.change(field("Seconds"), { target: { value: s } });
    };
    const start = () => within(bar).getByRole("button", { name: "Start" }) as HTMLButtonElement;
    const cases: [string, string, string, string | null][] = [
      ["0", "60", "0", "Minutes and seconds must be from 0 to 59."],
      ["0", "0", "60", "Minutes and seconds must be from 0 to 59."],
      ["1.5", "0", "0", "Use whole numbers of zero or more."],
      ["-1", "0", "0", "Use whole numbers of zero or more."],
      ["0", "0", "0", "Set a length above zero."],
      ["24", "0", "1", "A countdown can be at most 24 hours."],
      ["25", "0", "0", "A countdown can be at most 24 hours."],
      ["24", "0", "0", null],
    ];
    for (const [h, m, s, error] of cases) {
      set(h, m, s);
      expect(within(bar).queryByTestId("countdown-length-error")?.textContent ?? null).toBe(error);
      expect(start().disabled).toBe(error !== null);
    }
    expect(within(bar).getByTestId("timer-value").textContent).toBe("25:00"); // a draft changes no countdown
    expect((await loadTimer(services.db)).countdown.status).toBe("idle");

    set("1", "30", "45");
    fireEvent.click(start());
    await waitFor(async () => expect((await loadTimer(services.db)).countdown).toMatchObject({ status: "running", durationMs: 5_445_000 }));
    await waitFor(() => expect(within(bar).getByTestId("timer-value").textContent).toBe("1:30:45"));
    expect(within(bar).queryByTestId("countdown-length")).toBeNull(); // no length fields while it runs
    fireEvent.click(within(bar).getByRole("button", { name: "Pause" }));
    await waitFor(async () => expect((await loadTimer(services.db)).countdown).toMatchObject({ status: "paused", durationMs: 5_445_000, remainingMs: 5_445_000 }));
    expect(within(bar).queryByTestId("countdown-length")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(field("Hours").value).toBe("1"));
    expect([field("Minutes").value, field("Seconds").value]).toEqual(["30", "45"]);
    expect((await loadTimer(services.db)).countdown).toMatchObject({ status: "idle", durationMs: 5_445_000 });
  });

  it("the length draft follows the last set length in both views: a countdown started in the main window updates the floating window's fields", async () => {
    const f = testFloatingWindow();
    await renderApp();
    const bar = await screen.findByTestId("timer-bar");
    fireEvent.click(within(bar).getByRole("tab", { name: "Countdown" }));
    await waitFor(() => expect(within(bar).getByRole("tab", { name: "Countdown" }).getAttribute("aria-selected")).toBe("true"));
    f.resize(340, 300);
    fireEvent.click(await within(bar).findByTestId("open-floating"));
    await f.view();
    const floatingField = (name: string) => within(f.current()).getByLabelText(name) as HTMLInputElement;
    await waitFor(() => expect(floatingField("Minutes").value).toBe("25"));
    fireEvent.change(within(bar).getByLabelText("Hours"), { target: { value: "1" } });
    fireEvent.change(within(bar).getByLabelText("Minutes"), { target: { value: "30" } });
    fireEvent.change(within(bar).getByLabelText("Seconds"), { target: { value: "45" } });
    expect(floatingField("Minutes").value).toBe("25"); // an unsaved draft stays in its own view
    fireEvent.click(within(bar).getByRole("button", { name: "Start" }));
    await waitFor(async () => expect((await loadTimer(services.db)).countdown.durationMs).toBe(5_445_000));
    await waitFor(() => expect(within(f.current()).getByTestId("timer-status").textContent).toBe("Running"));
    fireEvent.click(within(f.current()).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(floatingField("Hours").value).toBe("1"));
    expect([floatingField("Minutes").value, floatingField("Seconds").value]).toEqual(["30", "45"]);
  });

  it("the countdown length fields and their errors are in Persian", async () => {
    await renderApp(async (s) => updateDeviceSettings(s.db, { language: "fa" }));
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    const bar = await screen.findByTestId("timer-bar");
    fireEvent.click(await within(bar).findByRole("tab", { name: "شمارش معکوس" }));
    expect(await within(bar).findByText("مدت شمارش معکوس")).toBeTruthy();
    for (const label of ["ساعت", "دقیقه", "ثانیه"]) expect(await within(bar).findByLabelText(label)).toBeTruthy();
    fireEvent.change(within(bar).getByLabelText("ثانیه"), { target: { value: "75" } });
    expect(within(bar).getByTestId("countdown-length-error").textContent).toBe("دقیقه و ثانیه باید از ۰ تا ۵۹ باشند.");
    fireEvent.change(within(bar).getByLabelText("ساعت"), { target: { value: "30" } });
    fireEvent.change(within(bar).getByLabelText("ثانیه"), { target: { value: "0" } });
    expect(within(bar).getByTestId("countdown-length-error").textContent).toBe("شمارش معکوس حداکثر ۲۴ ساعت است.");
    expect((within(bar).getByRole("button", { name: "شروع" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is translated in Persian with right-to-left direction", async () => {
    await renderApp(async (s) => updateDeviceSettings(s.db, { language: "fa" }));
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    expect(within(await screen.findByTestId("timer-bar")).getByText(/تایمر/)).toBeTruthy();
    await goTo("داشبورد");
    expect(await screen.findByRole("heading", { level: 1, name: "داشبوردها" })).toBeTruthy();
    expect((await screen.findAllByText("پیوستگی استفاده از برنامه")).length).toBeGreaterThan(0);
  });
});
