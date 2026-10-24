/**
 * Stage 3 planning on the device (docs/TESTING.md "Stage 3 acceptance tests" 6–20): recurrence
 * and unscheduled items, blocks and their rules, time-zone changes, and capacity. Fixed dates and
 * zones; nothing depends on the machine's clock or zone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CALENDAR_BLOCKS, type CalendarBlockData, PRODUCT_REGISTRY, type Recurrence, TASK_DEFINITIONS } from "../backup/registry.ts";
import { createTestDevice, type TestDevice } from "../backup/test-fixtures.ts";
import { snapshot } from "../backup/test-helpers.ts";
import {
  blockLabel,
  blocksOn,
  capacityStatus,
  filterBlocks,
  filterUnscheduled,
  isOccurrenceScheduled,
  NO_FILTER,
  overlapGroups,
  overlappingBlockIds,
  plannedMinutesOn,
  unscheduledItemsOn,
} from "../planning/planning.ts";
import { datesBetween } from "../planning/time.ts";
import type { LocalDb } from "./db.ts";
import { createProject, createTask, createWorkstream, loadOrganization, setArchived, updateProject, updateTask, updateWorkstream } from "./organization.ts";
import { createBlock, loadBlocks, quickAddBlock, setBlockCancelled, setRecurrence, updateBlock } from "./planning.ts";
import { deleteRecord, putRecord } from "./records.ts";
import { updateSharedPreferences } from "./settings.ts";

const devices: TestDevice[] = [];
async function device(zone: string | null = "Asia/Tehran") {
  const d = await createTestDevice("P");
  devices.push(d);
  if (zone) await updateSharedPreferences(d.db, { timeZone: zone });
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).name;
  }
};

const weekly = (weekdays: number[], startDate: string, endDate: string | null = null): Recurrence => ({ kind: "weekdays", weekdays, startDate, endDate });

async function state(db: LocalDb) {
  const org = await loadOrganization(db);
  return { tasks: org.tasks, blocks: await loadBlocks(db), map: new Map(org.tasks.map((t) => [t.id, t.data])) };
}

async function unscheduledOn(db: LocalDb, date: string) {
  const s = await state(db);
  return unscheduledItemsOn(s.tasks, s.blocks, date).map((i) => s.map.get(i.taskId)!.title);
}

const blockRow = async (db: LocalDb, id: string) => (await db.records.get([CALENDAR_BLOCKS, id]))!;

describe("6. without a configured time zone nothing is planned", () => {
  it("blocks, quick add, and recurrence are refused and nothing is written", async () => {
    const d = await device(null);
    const task = await createTask(d.db, { title: "Read" });
    const before = await snapshot(d.db);
    expect(await codeOf(createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 30 }))).toBe("NO_TIME_ZONE");
    expect(await codeOf(quickAddBlock(d.db, { title: "Call", date: "2026-11-02", startTime: "09:00", durationMinutes: 30 }))).toBe("NO_TIME_ZONE");
    expect(await codeOf(setRecurrence(d.db, task, weekly([1], "2026-11-02")))).toBe("NO_TIME_ZONE");
    expect(await snapshot(d.db)).toEqual(before);
  });
});

describe("7. recurring tasks show one unscheduled item per selected weekday", () => {
  it("within the start and end dates (inclusive), none elsewhere; archived and non-recurring tasks show none", async () => {
    const d = await device();
    const gym = await createTask(d.db, { title: "Gym" });
    await setRecurrence(d.db, gym, weekly([1, 3], "2026-11-02", "2026-11-11")); // Mon, Wed
    await createTask(d.db, { title: "Once" });
    const archived = await createTask(d.db, { title: "Old routine" });
    await setRecurrence(d.db, archived, weekly([0, 1, 2, 3, 4, 5, 6], "2026-01-01"));
    await setArchived(d.db, TASK_DEFINITIONS, archived, true);

    const s = await state(d.db);
    const byDate = Object.fromEntries(datesBetween("2026-10-31", "2026-11-14").map((date) => [date, unscheduledItemsOn(s.tasks, s.blocks, date).length]));
    expect(Object.entries(byDate).filter(([, n]) => n > 0).map(([date]) => date)).toEqual(["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11"]);
    expect(Object.values(byDate).every((n) => n <= 1)).toBe(true);
  });

  it("stores weekdays sorted and distinct; a weekly weekday pattern is the only shape accepted", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Gym" });
    await setRecurrence(d.db, task, weekly([3, 1, 3], "2026-11-02"));
    expect((await d.db.records.get([TASK_DEFINITIONS, task]))!.data.recurrence).toEqual(weekly([1, 3], "2026-11-02"));
    const bad = [
      { kind: "monthly", weekdays: [1], startDate: "2026-11-02", endDate: null },
      { kind: "weekdays", weekdays: [], startDate: "2026-11-02", endDate: null },
      { kind: "weekdays", weekdays: [7], startDate: "2026-11-02", endDate: null },
      { kind: "weekdays", weekdays: [1], startDate: "2026-11-02", endDate: "2026-11-01" },
      { kind: "weekdays", weekdays: [1], startDate: "2026-02-30", endDate: null },
      { kind: "weekdays", weekdays: [1], startDate: "2026-11-02", endDate: null, interval: 2 },
    ];
    for (const recurrence of bad) expect(await codeOf(updateTask(d.db, task, { recurrence: recurrence as Recurrence }))).toBe("ZodError");
  });

  it("turning recurrence off removes the field (never null) and changes no block", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Gym" });
    const hashBefore = (await d.db.records.get([TASK_DEFINITIONS, task]))!.contentHash;
    await setRecurrence(d.db, task, weekly([1], "2026-11-02"));
    const block = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "18:00", durationMinutes: 60, occurrenceDate: "2026-11-02" });
    const blockBefore = await blockRow(d.db, block);
    await setRecurrence(d.db, task, null);
    const row = (await d.db.records.get([TASK_DEFINITIONS, task]))!;
    expect("recurrence" in row.data).toBe(false);
    expect(row.contentHash).toBe(hashBefore); // same data as before recurrence was added
    expect(await blockRow(d.db, block)).toEqual(blockBefore);
  });
});

describe("8–9. scheduling occurrences (T-033, D-023)", () => {
  async function recurring() {
    const d = await device();
    const task = await createTask(d.db, { title: "Gym", estimateMinutes: 45 });
    await setRecurrence(d.db, task, weekly([1], "2026-11-02"));
    return { d, task };
  }

  it("one block: scheduled; cancelling it unschedules; restoring schedules again; another date still counts", async () => {
    const { d, task } = await recurring();
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual(["Gym"]);
    const block = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "18:15", durationMinutes: 45, occurrenceDate: "2026-11-02" });
    const data = (await blockRow(d.db, block)).data as CalendarBlockData;
    expect(data).toMatchObject({ startsAt: "2026-11-02T14:45:00.000Z", endsAt: "2026-11-02T15:30:00.000Z", localDate: "2026-11-02", timeZone: "Asia/Tehran" });
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual([]);
    await setBlockCancelled(d.db, block, true);
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual(["Gym"]);
    await setBlockCancelled(d.db, block, false);
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual([]);

    // The user moved the next occurrence's block to Sunday: it still schedules Monday's occurrence.
    await createBlock(d.db, { taskId: task, date: "2026-11-08", startTime: "10:00", durationMinutes: 45, occurrenceDate: "2026-11-09" });
    expect(await unscheduledOn(d.db, "2026-11-09")).toEqual([]);
    expect(await unscheduledOn(d.db, "2026-11-08")).toEqual([]); // Sunday has no occurrence of its own
  });

  it("several blocks: cancelling one keeps it scheduled; the last one unschedules; restoring either reschedules", async () => {
    const { d, task } = await recurring();
    const other = await createTask(d.db, { title: "Other" });
    const a = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "07:00", durationMinutes: 20, occurrenceDate: "2026-11-02" });
    const b = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "19:00", durationMinutes: 25, occurrenceDate: "2026-11-02" });
    await createBlock(d.db, { taskId: other, date: "2026-11-02", startTime: "12:00", durationMinutes: 30, occurrenceDate: "2026-11-02" });
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "13:00", durationMinutes: 30, occurrenceDate: "2026-11-09" });

    const scheduled = async () => isOccurrenceScheduled((await state(d.db)).blocks, task, "2026-11-02");
    const capacityNotice = async () => {
      const s = await state(d.db);
      const items = unscheduledItemsOn(s.tasks, s.blocks, "2026-11-02");
      const status = capacityStatus(60, plannedMinutesOn(s.blocks, "2026-11-02", "Asia/Tehran"), items, s.map);
      if (status.kind === "unset") throw new Error("capacity is set");
      return status;
    };
    expect(await scheduled()).toBe(true);
    await setBlockCancelled(d.db, a, true);
    expect(await scheduled()).toBe(true);
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual([]);
    const s = await state(d.db);
    expect(filterUnscheduled(unscheduledItemsOn(s.tasks, s.blocks, "2026-11-02"), { ...NO_FILTER, onlyUnscheduled: true }, s.map)).toEqual([]);
    expect((await capacityNotice()).withUnscheduled).toBe((await capacityNotice()).planned); // its estimate is not counted

    await setBlockCancelled(d.db, b, true); // the last planned block of that occurrence
    expect(await scheduled()).toBe(false);
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual(["Gym"]);
    expect((await capacityNotice()).withUnscheduled).toBe((await capacityNotice()).planned + 45);

    await setBlockCancelled(d.db, b, false);
    expect(await scheduled()).toBe(true);
    await setBlockCancelled(d.db, a, false);
    expect(await scheduled()).toBe(true);
    await setBlockCancelled(d.db, a, true);
    await setBlockCancelled(d.db, b, true);
    await setBlockCancelled(d.db, a, false); // restoring the OTHER one also reschedules
    expect(await scheduled()).toBe(true);
  });
});

describe("10–11. nothing happens automatically; task edits leave blocks unchanged", () => {
  it("editing, archiving, recurrence changes, zone changes, and reading views never write a block", async () => {
    const d = await device();
    const project = await createProject(d.db, { name: "Health" });
    const ws = await createWorkstream(d.db, { projectId: project, name: "Fitness" });
    const task = await createTask(d.db, { title: "Gym", projectId: project, workstreamId: ws });
    await setRecurrence(d.db, task, weekly([1], "2026-11-02"));
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "18:00", durationMinutes: 60, occurrenceDate: "2026-11-02" });
    const blocksBefore = (await loadBlocks(d.db)).map((b) => b.id);
    const rows = async () => (await d.db.records.where("type").equals(CALENDAR_BLOCKS).toArray()).map((r) => [r.id, r.contentHash, r.version]);
    const before = await rows();

    await updateTask(d.db, task, { title: "Gym (renamed)", estimateMinutes: 50 });
    await setRecurrence(d.db, task, weekly([1, 4], "2026-11-01"));
    await updateProject(d.db, project, { name: "Health 2" });
    await updateWorkstream(d.db, ws, { name: "Fitness 2" });
    await updateTask(d.db, task, { projectId: null, workstreamId: null });
    await setArchived(d.db, TASK_DEFINITIONS, task, true);
    await updateSharedPreferences(d.db, { timeZone: "Asia/Tokyo" });
    const s = await state(d.db);
    for (const date of datesBetween("2026-10-30", "2026-11-12")) {
      unscheduledItemsOn(s.tasks, s.blocks, date);
      blocksOn(s.blocks, date, "Asia/Tokyo");
    }
    expect(await rows()).toEqual(before);
    expect((await loadBlocks(d.db)).map((b) => b.id)).toEqual(blocksBefore);
    // The snapshot keeps the names at planning time (T-036); labels use the current title.
    const block = (await loadBlocks(d.db))[0]!;
    expect(block.data.snapshot).toEqual({ taskTitle: "Gym", projectId: project, projectName: "Health", workstreamId: ws, workstreamName: "Fitness" });
    expect(blockLabel(block.data, s.map).title).toBe("Gym (renamed)");
  });

  it("a past unscheduled item is never shown on a later date", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Weekly review" });
    await setRecurrence(d.db, task, weekly([5], "2026-10-01")); // Fridays
    expect(await unscheduledOn(d.db, "2026-10-30")).toEqual(["Weekly review"]);
    for (const date of datesBetween("2026-10-31", "2026-11-05")) expect(await unscheduledOn(d.db, date)).toEqual([]);
  });
});

describe("12–13. block rules, editing, quick add (T-027, T-030, T-032, T-036)", () => {
  it("typed-in data is validated; violations change nothing", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Write" });
    const good: CalendarBlockData = {
      taskId: task,
      startsAt: "2026-11-02T05:30:00.000Z",
      endsAt: "2026-11-02T06:30:00.000Z",
      timeZone: "Asia/Tehran",
      localDate: "2026-11-02",
      occurrenceDate: null,
      status: "planned",
      snapshot: { taskTitle: "Write", projectId: null, projectName: null, workstreamId: null, workstreamName: null },
    };
    const before = await snapshot(d.db);
    const put = (data: Partial<CalendarBlockData>) => codeOf(putRecord(d.db, PRODUCT_REGISTRY, CALENDAR_BLOCKS, crypto.randomUUID(), { ...good, ...data }));
    expect(await put({ endsAt: good.startsAt })).toBe("ZodError");
    expect(await put({ endsAt: "2026-11-03T06:31:00.000Z" })).toBe("ZodError"); // over 24 hours
    expect(await put({ startsAt: "2026-11-02T05:30:30.000Z" })).toBe("ZodError"); // not whole minutes
    expect(await put({ localDate: "2026-11-01" })).toBe("ZodError");
    expect(await put({ timeZone: "Mars/Olympus" })).toBe("ZodError");
    expect(await put({ status: "done" as never })).toBe("ZodError");
    expect(await put({ snapshot: { ...good.snapshot, projectName: "x" } })).toBe("ZodError");
    expect(await put({ taskId: crypto.randomUUID() })).toBe("BROKEN_LINK");
    expect(await snapshot(d.db)).toEqual(before);
    expect(await put({})).toBe("OK");
    expect(await put({ endsAt: "2026-11-03T05:30:00.000Z" })).toBe("OK"); // exactly 24 hours
  });

  it("a daylight-saving gap is refused; an ambiguous time uses the earlier instant", async () => {
    const d = await device("Europe/London");
    const task = await createTask(d.db, { title: "Night shift" });
    const before = await snapshot(d.db);
    expect(await codeOf(createBlock(d.db, { taskId: task, date: "2026-03-29", startTime: "01:30", durationMinutes: 30 }))).toBe("DST_GAP");
    expect(await snapshot(d.db)).toEqual(before);
    const id = await createBlock(d.db, { taskId: task, date: "2026-10-25", startTime: "01:30", durationMinutes: 30 });
    expect((await blockRow(d.db, id)).data.startsAt).toBe("2026-10-25T00:30:00.000Z");
  });

  it("edit (move/resize), cancel, restore, quick add persist after a restart; there is no delete", async () => {
    const d = await device();
    const project = await createProject(d.db, { name: "Thesis" });
    const task = await createTask(d.db, { title: "Draft", projectId: project });
    const id = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    await updateProject(d.db, project, { name: "Thesis (final)" });
    await updateBlock(d.db, id, { date: "2026-11-03", startTime: "10:30", durationMinutes: 90 });
    await setBlockCancelled(d.db, id, true);
    const quick = await quickAddBlock(d.db, { title: "  Call the bank  ", date: "2026-11-02", startTime: "16:00", durationMinutes: 15 });
    await d.restart();

    const moved = (await blockRow(d.db, id)).data as CalendarBlockData;
    expect(moved).toMatchObject({ startsAt: "2026-11-03T07:00:00.000Z", endsAt: "2026-11-03T08:30:00.000Z", localDate: "2026-11-03", status: "cancelled" });
    expect(moved.snapshot.projectName).toBe("Thesis (final)"); // editing the block refreshed its snapshot
    const quickTask = (await d.db.records.get([TASK_DEFINITIONS, quick.taskId]))!.data;
    expect(quickTask).toMatchObject({ title: "Call the bank", projectId: null }); // an inbox task
    expect(((await blockRow(d.db, quick.blockId)).data as CalendarBlockData).taskId).toBe(quick.taskId);
    expect(await d.db.tombstones.count()).toBe(0);
    await setBlockCancelled(d.db, id, false);
    expect(((await blockRow(d.db, id)).data as CalendarBlockData).status).toBe("planned");
  });

  it("quick add is one transaction: a refused time creates no task", async () => {
    const d = await device("Europe/London");
    const before = await snapshot(d.db);
    expect(await codeOf(quickAddBlock(d.db, { title: "Ghost", date: "2026-03-29", startTime: "01:15", durationMinutes: 15 }))).toBe("DST_GAP");
    expect(await codeOf(quickAddBlock(d.db, { title: "Ghost", date: "2026-11-02", startTime: "09:00", durationMinutes: 0 }))).toBe("INVALID_DURATION");
    expect(await snapshot(d.db)).toEqual(before);
  });

  it("a block edit needs its task on this device (live link)", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Draft" });
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    // Simulates a task that is gone (deletions arrive only through backup choices, which refuse
    // to delete a task with blocks — see the backup tests); a block write never dangles.
    await deleteRecord(d.db, TASK_DEFINITIONS, task);
    const blocks = await loadBlocks(d.db);
    expect(await codeOf(setBlockCancelled(d.db, blocks[0]!.id, true))).toBe("NOT_FOUND"); // never writes a dangling link
  });

  it("cancel and restore are edits of the block: snapshot and planning zone refresh; instants and occurrence never change", async () => {
    const d = await device("Asia/Tehran");
    const task = await createTask(d.db, { title: "Gym" });
    const id = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "23:00", durationMinutes: 45, occurrenceDate: "2026-11-02" });
    const before = (await blockRow(d.db, id)).data as CalendarBlockData;
    await updateTask(d.db, task, { title: "Gym (evening)" });
    await updateSharedPreferences(d.db, { timeZone: "Asia/Tokyo" });
    await setBlockCancelled(d.db, id, true);
    const after = (await blockRow(d.db, id)).data as CalendarBlockData;
    expect(after).toEqual({
      ...before,
      status: "cancelled",
      timeZone: "Asia/Tokyo",
      localDate: "2026-11-03",
      snapshot: { ...before.snapshot, taskTitle: "Gym (evening)" },
    });
    const version = (await blockRow(d.db, id)).version;
    await setBlockCancelled(d.db, id, true); // already cancelled: no write
    expect((await blockRow(d.db, id)).version).toEqual(version);
  });
});

describe("14–15. midnight, overlaps, views, search and filters", () => {
  it("a block crossing midnight appears on both dates, clipped; overlaps are both shown and neither moves", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Late" });
    const other = await createTask(d.db, { title: "Overlap" });
    const late = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "23:00", durationMinutes: 120 });
    const over = await createBlock(d.db, { taskId: other, date: "2026-11-03", startTime: "00:30", durationMinutes: 60 });
    const { blocks } = await state(d.db);
    expect(blocksOn(blocks, "2026-11-02", "Asia/Tehran").map((b) => b.id)).toEqual([late]);
    expect(blocksOn(blocks, "2026-11-03", "Asia/Tehran").map((b) => b.id)).toEqual([late, over]);
    expect(plannedMinutesOn(blocks, "2026-11-02", "Asia/Tehran")).toBe(60);
    expect(plannedMinutesOn(blocks, "2026-11-03", "Asia/Tehran")).toBe(120); // 60 + 60, overlap counted twice
    expect([...overlappingBlockIds(blocks, "2026-11-03", "Asia/Tehran")].sort()).toEqual([late, over].sort());
    expect(overlappingBlockIds(blocks, "2026-11-02", "Asia/Tehran").size).toBe(0);
    // Shown side by side as one group; a later block and a cancelled one stand alone.
    const after = await createBlock(d.db, { taskId: other, date: "2026-11-03", startTime: "09:00", durationMinutes: 30 });
    const cancelled = await createBlock(d.db, { taskId: other, date: "2026-11-03", startTime: "09:10", durationMinutes: 10 });
    await setBlockCancelled(d.db, cancelled, true);
    const shown = blocksOn((await state(d.db)).blocks, "2026-11-03", "Asia/Tehran");
    expect(overlapGroups(shown, "2026-11-03", "Asia/Tehran").map((g) => g.map((b) => b.id))).toEqual([[late, over], [after], [cancelled]]);
    expect((await loadBlocks(d.db)).find((b) => b.id === over)!.data.startsAt).toBe("2026-11-02T21:00:00.000Z"); // not moved
  });

  it("a cancelled block between overlapping planned blocks does not split their side-by-side group", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Write" });
    const first = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "10:00", durationMinutes: 120 });
    const cancelled = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "10:30", durationMinutes: 30 });
    const second = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "11:00", durationMinutes: 120 });
    await setBlockCancelled(d.db, cancelled, true);
    const { blocks } = await state(d.db);
    const shown = blocksOn(filterBlocks(blocks, { ...NO_FILTER, showCancelled: true }, (await state(d.db)).map), "2026-11-02", "Asia/Tehran");
    expect(shown.map((b) => b.id)).toEqual([first, cancelled, second]); // the cancelled block sorts between them
    expect(overlapGroups(shown, "2026-11-02", "Asia/Tehran").map((g) => g.map((b) => b.id))).toEqual([[first, second], [cancelled]]);
    expect([...overlappingBlockIds(blocks, "2026-11-02", "Asia/Tehran")].sort()).toEqual([first, second].sort()); // not the cancelled one
    expect(plannedMinutesOn(blocks, "2026-11-02", "Asia/Tehran")).toBe(240);
  });

  it("search by current and snapshot title; filters by project, inbox, workstream, cancelled, only unscheduled", async () => {
    const d = await device();
    const project = await createProject(d.db, { name: "Thesis" });
    const ws = await createWorkstream(d.db, { projectId: project, name: "Writing" });
    const inProject = await createTask(d.db, { title: "Draft chapter", projectId: project, workstreamId: ws });
    const inbox = await createTask(d.db, { title: "Call the bank" });
    const recurring = await createTask(d.db, { title: "Gym" });
    await setRecurrence(d.db, recurring, weekly([1], "2026-11-02"));
    const b1 = await createBlock(d.db, { taskId: inProject, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    const b2 = await createBlock(d.db, { taskId: inbox, date: "2026-11-02", startTime: "11:00", durationMinutes: 15 });
    await setBlockCancelled(d.db, b2, true);
    await updateTask(d.db, inProject, { title: "Write chapter 2" }); // snapshot still says "Draft chapter"

    const s = await state(d.db);
    const ids = (filter: Partial<typeof NO_FILTER>) => filterBlocks(s.blocks, { ...NO_FILTER, ...filter }, s.map).map((b) => b.id);
    expect(ids({})).toEqual([b1]); // cancelled hidden by default
    expect(ids({ showCancelled: true }).sort()).toEqual([b1, b2].sort());
    expect(ids({ query: "write" })).toEqual([b1]);
    expect(ids({ query: "draft" })).toEqual([b1]); // the snapshot title is searched too
    expect(ids({ project, workstream: ws })).toEqual([b1]);
    expect(ids({ project: "inbox", showCancelled: true })).toEqual([b2]);
    expect(ids({ onlyUnscheduled: true })).toEqual([]);
    const items = unscheduledItemsOn(s.tasks, s.blocks, "2026-11-02");
    expect(filterUnscheduled(items, { ...NO_FILTER, query: "gym" }, s.map)).toHaveLength(1);
    expect(filterUnscheduled(items, { ...NO_FILTER, project }, s.map)).toHaveLength(0);
    // A block whose task is not on this device shows its snapshot.
    expect(blockLabel({ ...s.blocks[0]!.data, taskId: crypto.randomUUID() }, s.map)).toMatchObject({ title: s.blocks[0]!.data.snapshot.taskTitle, fromSnapshot: true });
  });
});

describe("16–17. changing the time zone (D-022)", () => {
  it("writes no block; blocks display at their fixed instants in the new zone", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Gym" });
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    const before = await d.db.records.where("type").equals(CALENDAR_BLOCKS).toArray();
    await updateSharedPreferences(d.db, { timeZone: "Europe/London" });
    expect(await d.db.records.where("type").equals(CALENDAR_BLOCKS).toArray()).toEqual(before);
    const { blocks } = await state(d.db);
    expect(blocksOn(blocks, "2026-11-02", "Europe/London")).toHaveLength(1); // 05:30 London
  });

  it("across a date boundary: the block keeps scheduling its original occurrence; no duplicate item", async () => {
    const d = await device("Asia/Tehran");
    const task = await createTask(d.db, { title: "Gym" });
    await setRecurrence(d.db, task, weekly([1, 2], "2026-11-01")); // Monday and Tuesday
    const late = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "23:00", durationMinutes: 45, occurrenceDate: "2026-11-02" });
    expect((await blockRow(d.db, late)).data).toMatchObject({ startsAt: "2026-11-02T19:30:00.000Z", endsAt: "2026-11-02T20:15:00.000Z" });
    const stored = await blockRow(d.db, late);

    await updateSharedPreferences(d.db, { timeZone: "Asia/Tokyo" });
    let s = await state(d.db);
    expect(blocksOn(s.blocks, "2026-11-03", "Asia/Tokyo").map((b) => b.id)).toEqual([late]); // 04:30–05:15 Tuesday
    expect(blocksOn(s.blocks, "2026-11-02", "Asia/Tokyo")).toEqual([]);
    expect(plannedMinutesOn(s.blocks, "2026-11-03", "Asia/Tokyo")).toBe(45);
    expect(await blockRow(d.db, late)).toEqual(stored); // occurrenceDate still 2026-11-02
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual([]); // no duplicate for Monday
    expect(await unscheduledOn(d.db, "2026-11-03")).toEqual(["Gym"]); // Tuesday's own occurrence

    // Reverse direction: 00:30 Tehran shows on the previous day in New York.
    await updateSharedPreferences(d.db, { timeZone: "Asia/Tehran" });
    const early = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "00:30", durationMinutes: 30, occurrenceDate: "2026-11-02" });
    await setBlockCancelled(d.db, late, true); // the early block alone schedules Monday now
    await updateSharedPreferences(d.db, { timeZone: "America/New_York" });
    s = await state(d.db);
    expect(blocksOn(s.blocks, "2026-11-01", "America/New_York").map((b) => b.id)).toEqual([early]);
    expect(await unscheduledOn(d.db, "2026-11-02")).toEqual([]);
    await updateSharedPreferences(d.db, { timeZone: "Asia/Tehran" });
    s = await state(d.db);
    expect(blocksOn(s.blocks, "2026-11-02", "Asia/Tehran").map((b) => b.id).sort()).toEqual([early, late].sort());
  });
});

describe("19–20. capacity (D-021, T-031)", () => {
  it("warning, softer notice, items without estimates, and no capacity", async () => {
    const d = await device();
    const a = await createTask(d.db, { title: "A" });
    const est = await createTask(d.db, { title: "Estimated", estimateMinutes: 40 });
    const none = await createTask(d.db, { title: "No estimate" });
    await setRecurrence(d.db, est, weekly([1], "2026-11-02"));
    await setRecurrence(d.db, none, weekly([1], "2026-11-02"));
    await createBlock(d.db, { taskId: a, date: "2026-11-02", startTime: "09:00", durationMinutes: 100 });
    const s = await state(d.db);
    const planned = plannedMinutesOn(s.blocks, "2026-11-02", "Asia/Tehran");
    const items = unscheduledItemsOn(s.tasks, s.blocks, "2026-11-02");
    expect(planned).toBe(100);
    expect(capacityStatus(undefined, planned, items, s.map)).toEqual({ kind: "unset", planned: 100 });
    expect(capacityStatus(90, planned, items, s.map)).toMatchObject({ kind: "warning", excess: 10 });
    expect(capacityStatus(100, planned, items, s.map)).toMatchObject({ kind: "notice", withUnscheduled: 140, noEstimate: [none] });
    expect(capacityStatus(140, planned, items, s.map)).toMatchObject({ kind: "ok", noEstimate: [none] });
  });

  it("capacity is whole minutes 1–1,440, one value; removing it deletes the field; nothing else changes", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "A" });
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 600 });
    for (const bad of [0, 1441, 30.5]) expect(await codeOf(updateSharedPreferences(d.db, { dailyCapacityMinutes: bad }))).toBe("ZodError");
    const blocksBefore = await d.db.records.where("type").equals(CALENDAR_BLOCKS).toArray();
    await updateSharedPreferences(d.db, { dailyCapacityMinutes: 60 });
    // Saving another block over capacity is allowed; nothing is moved or cancelled.
    const second = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "20:00", durationMinutes: 60 });
    const after = await d.db.records.where("type").equals(CALENDAR_BLOCKS).toArray();
    expect(after.filter((r) => r.id !== second)).toEqual(blocksBefore);
    await updateSharedPreferences(d.db, { dailyCapacityMinutes: null });
    const prefs = (await d.db.records.get(["preferences", "00000000-0000-4000-8000-000000000001"]))!.data;
    expect("dailyCapacityMinutes" in prefs).toBe(false);
  });
});
