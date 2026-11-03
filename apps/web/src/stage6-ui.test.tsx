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
import { CORRECTIONS, GOAL_WEEK_ALLOCATIONS, type GoalWeekAllocationData, MAIN_DASHBOARD_ID, SESSIONS, type SessionData } from "./backup/registry.ts";
import { createGoal } from "./local/goals.ts";
import { setWeekAllocation } from "./local/goal-plans.ts";
import { loadInsightRecords } from "./local/insights.ts";
import { createTask } from "./local/organization.ts";
import { updateDeviceSettings } from "./local/records.ts";
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

describe("19. timer (T-230 to T-236)", () => {
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

  it("is translated in Persian with right-to-left direction", async () => {
    await renderApp(async (s) => updateDeviceSettings(s.db, { language: "fa" }));
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    expect(within(await screen.findByTestId("timer-bar")).getByText(/تایمر/)).toBeTruthy();
    await goTo("داشبورد");
    expect(await screen.findByRole("heading", { level: 1, name: "داشبوردها" })).toBeTruthy();
    expect((await screen.findAllByText("پیوستگی استفاده از برنامه")).length).toBeGreaterThan(0);
  });
});
