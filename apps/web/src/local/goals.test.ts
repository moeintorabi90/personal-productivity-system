/**
 * Stage 4 goal and milestone rules on the device (docs/TESTING.md "Stage 4 acceptance tests" 1–7;
 * DECISIONS T-037 to T-065, T-077 to T-087).
 */
import { afterEach, describe, expect, it } from "vitest";
import { GOALS, MILESTONES, PRODUCT_REGISTRY } from "../backup/registry.ts";
import { createTestDevice, type TestDevice } from "../backup/test-fixtures.ts";
import {
  canChangeStatus,
  createGoal,
  createMilestone,
  deadlineWithinGoal,
  defaultStartDate,
  deleteMilestone,
  filterGoals,
  GoalError,
  type GoalInput,
  loadGoals,
  milestonesOfGoal,
  milestonesOutside,
  setGoalArchived,
  setGoalStatus,
  setMilestoneCompleted,
  updateGoal,
  updateMilestone,
} from "./goals.ts";
import { createProject, setArchived } from "./organization.ts";
import { putRecord, RecordRuleError } from "./records.ts";

const devices: TestDevice[] = [];
async function device(label = "D") {
  const d = await createTestDevice(label);
  devices.push(d);
  return d.db;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    if (e instanceof GoalError || e instanceof RecordRuleError) return e.code;
    return (e as Error).name;
  }
};

const pages: GoalInput = { name: "Write the book", startDate: "2026-11-01", deadline: "2026-12-31", kind: "output", target: 300, unit: "pages" };
const goalData = async (db: Awaited<ReturnType<typeof device>>, id: string) => (await db.records.get([GOALS, id]))!.data;
const milestoneData = async (db: Awaited<ReturnType<typeof device>>, id: string) => (await db.records.get([MILESTONES, id]))!.data;

describe("1–2. creating goals", () => {
  it("stores each kind with its target; only output goals have a unit; status starts active", async () => {
    const db = await device();
    const project = await createProject(db, { name: "Thesis" });
    const output = await createGoal(db, { ...pages, name: "  Write the book  ", description: " d ", projectId: project });
    const time = await createGoal(db, { name: "Study", startDate: "2026-10-01", kind: "time", target: 40 * 60 + 30, unit: "ignored" });
    const count = await createGoal(db, { name: "Finish tasks", startDate: "2027-01-01", kind: "taskCount", target: 20 });
    expect(await goalData(db, output)).toEqual({
      name: "Write the book",
      description: "d",
      projectId: project,
      startDate: "2026-11-01",
      deadline: "2026-12-31",
      kind: "output",
      target: 300,
      unit: "pages",
      status: "active",
      archivedAt: null,
    });
    expect(await goalData(db, time)).toMatchObject({ kind: "time", target: 2430, deadline: null, projectId: null });
    expect(await goalData(db, time)).not.toHaveProperty("unit");
    expect(await goalData(db, count)).not.toHaveProperty("unit");
  });

  it("refuses a blank name, a deadline before the start, bad targets, and a missing unit", async () => {
    const db = await device();
    expect(await codeOf(createGoal(db, { ...pages, name: "  " }))).toBe("ZodError");
    expect(await codeOf(createGoal(db, { ...pages, deadline: "2026-10-31" }))).toBe("DEADLINE_BEFORE_START");
    expect(await codeOf(createGoal(db, { ...pages, deadline: "2026-11-01" }))).toBe("OK"); // same day is fine
    for (const target of [0, -1, 2.5, 1_000_000_001]) expect(await codeOf(createGoal(db, { ...pages, target }))).toBe("INVALID_TARGET");
    expect(await codeOf(createGoal(db, { ...pages, kind: "time", target: 1_000_001 }))).toBe("INVALID_TARGET");
    expect(await codeOf(createGoal(db, { ...pages, unit: " " }))).toBe("ZodError");
    expect(await codeOf(createGoal(db, { ...pages, projectId: crypto.randomUUID() }))).toBe("BROKEN_LINK");
    expect((await loadGoals(db)).goals).toHaveLength(1);
  });

  it("the default start date is today in the configured zone, else the device's date", () => {
    const instant = Date.parse("2026-11-01T22:30:00Z"); // still Nov 1 in New York, already Nov 2 in Tehran
    expect(defaultStartDate("Asia/Tehran", instant)).toBe("2026-11-02");
    expect(defaultStartDate("America/New_York", instant)).toBe("2026-11-01");
    expect(defaultStartDate(null, instant)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("editing keeps the kind (T-079): target, unit, dates, and project can change", async () => {
    const db = await device();
    const id = await createGoal(db, pages);
    await updateGoal(db, id, { target: 350, unit: "  sheets ", name: "Book", startDate: "2026-10-15", deadline: null });
    expect(await goalData(db, id)).toMatchObject({ target: 350, unit: "sheets", name: "Book", startDate: "2026-10-15", deadline: null, kind: "output" });
    await expect(putRecord(db, PRODUCT_REGISTRY, GOALS, id, { ...(await goalData(db, id)), kind: "taskCount" })).rejects.toBeTruthy();
    expect(await codeOf(updateGoal(db, id, { target: 0 }))).toBe("INVALID_TARGET");
    expect((await goalData(db, id)).kind).toBe("output");
  });
});

describe("3–4. status, archive, and restore", () => {
  it("allows exactly pause, resume, complete (also from paused), and reopen; dates never change", async () => {
    expect(canChangeStatus("active", "paused")).toBe(true);
    expect(canChangeStatus("paused", "active")).toBe(true);
    expect(canChangeStatus("active", "completed")).toBe(true);
    expect(canChangeStatus("paused", "completed")).toBe(true);
    expect(canChangeStatus("completed", "active")).toBe(true);
    expect(canChangeStatus("completed", "paused")).toBe(false);

    const db = await device();
    const id = await createGoal(db, pages);
    await setGoalStatus(db, id, "paused");
    expect(await goalData(db, id)).toMatchObject({ status: "paused", startDate: "2026-11-01", deadline: "2026-12-31" });
    await setGoalStatus(db, id, "completed"); // without resuming (T-062)
    expect(await codeOf(setGoalStatus(db, id, "paused"))).toBe("INVALID_STATUS_CHANGE");
    await setGoalStatus(db, id, "active"); // reopen (T-060)
    expect(await goalData(db, id)).toMatchObject({ status: "active", startDate: "2026-11-01", deadline: "2026-12-31" });
  });

  it("archive keeps the status and restore returns to it; an archived goal is read-only", async () => {
    const db = await device();
    for (const status of ["active", "paused", "completed"] as const) {
      const id = await createGoal(db, pages);
      if (status !== "active") await setGoalStatus(db, id, status);
      const milestone = await createMilestone(db, { goalId: id, name: "Draft" });
      await setGoalArchived(db, id, true);
      expect(await goalData(db, id)).toMatchObject({ status });
      expect((await goalData(db, id)).archivedAt).not.toBeNull();
      expect(await codeOf(updateGoal(db, id, { name: "x" }))).toBe("ARCHIVED");
      expect(await codeOf(setGoalStatus(db, id, "completed"))).toBe("ARCHIVED");
      expect(await codeOf(createMilestone(db, { goalId: id, name: "More" }))).toBe("ARCHIVED");
      expect(await codeOf(setMilestoneCompleted(db, milestone, true))).toBe("ARCHIVED");
      expect(await codeOf(updateMilestone(db, milestone, { name: "x" }))).toBe("ARCHIVED");
      expect(await codeOf(deleteMilestone(db, milestone))).toBe("ARCHIVED");
      await setGoalArchived(db, id, false);
      expect(await goalData(db, id)).toMatchObject({ status, archivedAt: null });
    }
  });

  it("archiving a linked project changes nothing on the goal", async () => {
    const db = await device();
    const project = await createProject(db, { name: "P" });
    const id = await createGoal(db, { ...pages, projectId: project });
    const before = await db.records.get([GOALS, id]);
    await setArchived(db, "projects", project, true);
    expect(await db.records.get([GOALS, id])).toEqual(before);
  });
});

describe("5–6. milestones and the goal's date range", () => {
  it("needs a name, belongs to a goal, and its deadline must lie within the goal's dates", async () => {
    const db = await device();
    const goal = await createGoal(db, pages);
    expect(await codeOf(createMilestone(db, { goalId: goal, name: " " }))).toBe("ZodError");
    expect(await codeOf(createMilestone(db, { goalId: crypto.randomUUID(), name: "Lost" }))).toBe("NOT_FOUND");
    expect(await codeOf(createMilestone(db, { goalId: goal, name: "Early", deadline: "2026-10-31" }))).toBe("DEADLINE_OUTSIDE_GOAL");
    expect(await codeOf(createMilestone(db, { goalId: goal, name: "Late", deadline: "2027-01-01" }))).toBe("DEADLINE_OUTSIDE_GOAL");
    const first = await createMilestone(db, { goalId: goal, name: " First ", deadline: "2026-11-01" });
    const last = await createMilestone(db, { goalId: goal, name: "Last", deadline: "2026-12-31", description: "d" });
    const open = await createMilestone(db, { goalId: goal, name: "Undated" });
    expect(await milestoneData(db, first)).toEqual({ goalId: goal, name: "First", description: "", deadline: "2026-11-01", completedAt: null });
    expect(await codeOf(updateMilestone(db, last, { deadline: "2027-02-01" }))).toBe("DEADLINE_OUTSIDE_GOAL");
    const { milestones } = await loadGoals(db);
    expect(milestonesOfGoal(milestones, goal).map((m) => m.id)).toEqual([first, last, open]);
    // goalId never changes (T-083)
    await expect(putRecord(db, PRODUCT_REGISTRY, MILESTONES, first, { ...(await milestoneData(db, first)), goalId: await createGoal(db, pages) })).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
  });

  it("an open-ended goal accepts any milestone deadline on or after its start", () => {
    expect(deadlineWithinGoal("2099-01-01", { startDate: "2026-11-01", deadline: null })).toBe(true);
    expect(deadlineWithinGoal("2026-10-31", { startDate: "2026-11-01", deadline: null })).toBe(false);
    expect(deadlineWithinGoal(null, { startDate: "2026-11-01", deadline: "2026-11-02" })).toBe(true);
  });

  it("milestones complete and reopen independently; completing or reopening the goal keeps them (T-058, T-059, T-061)", async () => {
    const db = await device();
    const goal = await createGoal(db, pages);
    const a = await createMilestone(db, { goalId: goal, name: "A" });
    const b = await createMilestone(db, { goalId: goal, name: "B" });
    await setMilestoneCompleted(db, b, true);
    expect((await milestoneData(db, a)).completedAt).toBeNull();
    expect((await milestoneData(db, b)).completedAt).not.toBeNull();
    await setGoalStatus(db, goal, "completed");
    await setGoalStatus(db, goal, "active");
    expect((await milestoneData(db, a)).completedAt).toBeNull();
    expect((await milestoneData(db, b)).completedAt).not.toBeNull();
    await setMilestoneCompleted(db, b, false);
    expect((await milestoneData(db, b)).completedAt).toBeNull();
    // Milestones of a paused or completed goal can still change (T-083).
    await setGoalStatus(db, goal, "paused");
    await setMilestoneCompleted(db, a, true);
    expect((await milestoneData(db, a)).completedAt).not.toBeNull();
  });

  it("deleting a milestone leaves a tombstone (T-080)", async () => {
    const db = await device();
    const goal = await createGoal(db, pages);
    const m = await createMilestone(db, { goalId: goal, name: "Mistake" });
    await deleteMilestone(db, m);
    expect(await db.records.get([MILESTONES, m])).toBeUndefined();
    expect(await db.tombstones.get([MILESTONES, m])).toBeTruthy();
    expect(await codeOf(deleteMilestone(db, m))).toBe("NOT_FOUND");
  });

  it("a goal date change that would put a milestone outside is refused and names it; nothing is written (T-078)", async () => {
    const db = await device();
    const goal = await createGoal(db, pages);
    await createMilestone(db, { goalId: goal, name: "Chapter 10", deadline: "2026-12-20" });
    await createMilestone(db, { goalId: goal, name: "Kickoff", deadline: "2026-11-02" });
    const before = await db.records.get([GOALS, goal]);
    const error = await updateGoal(db, goal, { deadline: "2026-12-10" }).catch((e) => e);
    expect(error).toBeInstanceOf(GoalError);
    expect(error.code).toBe("MILESTONES_OUTSIDE_RANGE");
    expect(error.milestoneNames).toEqual(["Chapter 10"]);
    expect(await codeOf(updateGoal(db, goal, { startDate: "2026-11-05" }))).toBe("MILESTONES_OUTSIDE_RANGE");
    expect(await db.records.get([GOALS, goal])).toEqual(before);
    expect(await codeOf(updateGoal(db, goal, { deadline: "2026-12-20", startDate: "2026-10-01" }))).toBe("OK");
  });

  it("flags milestones outside the range (e.g. after a merge) without changing them", async () => {
    const db = await device();
    const goal = await createGoal(db, pages);
    const m = await createMilestone(db, { goalId: goal, name: "M", deadline: "2026-12-20" });
    const { milestones } = await loadGoals(db);
    expect(milestonesOutside(milestones, goal, { startDate: "2026-11-01", deadline: "2026-12-10" }).map((x) => x.id)).toEqual([m]);
    // A merged milestone outside the range can still be renamed without touching its deadline.
    await putRecord(db, PRODUCT_REGISTRY, GOALS, goal, { ...(await goalData(db, goal)), deadline: "2026-12-10" });
    expect(await codeOf(updateMilestone(db, m, { name: "Renamed" }))).toBe("OK");
  });
});

describe("7. lists, and no progress", () => {
  it("filters by status and archive; no progress is stored on any record", async () => {
    const db = await device();
    const active = await createGoal(db, { ...pages, name: "B active" });
    const paused = await createGoal(db, { ...pages, name: "A paused" });
    await setGoalStatus(db, paused, "paused");
    const archived = await createGoal(db, { ...pages, name: "C archived" });
    await setGoalArchived(db, archived, true);
    const { goals } = await loadGoals(db);
    expect(filterGoals(goals, "current").map((g) => g.id)).toEqual([paused, active]);
    expect(filterGoals(goals, "paused").map((g) => g.id)).toEqual([paused]);
    expect(filterGoals(goals, "archived").map((g) => g.id)).toEqual([archived]);
    expect(filterGoals(goals, "all")).toHaveLength(3);
    for (const g of goals) expect(Object.keys(g.data).some((k) => /progress|percent|done|actual/i.test(k))).toBe(false);
  });
});
