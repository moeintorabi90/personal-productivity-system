/**
 * Stage 3 follow-up on the device (docs/TESTING.md "Stage 3 follow-up" 2, 3, 4b, 6; DECISIONS
 * T-067, T-069, T-090): drag edits, Undo with its version guard, and color changes that write only
 * the project record. Fixed dates and zones.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CALENDAR_BLOCKS, type CalendarBlockData, PROJECTS } from "../backup/registry.ts";
import { createTestDevice, type TestDevice } from "../backup/test-fixtures.ts";
import { createProject, createTask, updateProject, updateTask } from "./organization.ts";
import { createBlock, dragBlockTimes, setBlockCancelled, undoBlockTimes, updateBlock } from "./planning.ts";
import { updateSharedPreferences } from "./settings.ts";

const devices: TestDevice[] = [];
async function device(zone = "Asia/Tehran") {
  const d = await createTestDevice("F");
  devices.push(d);
  await updateSharedPreferences(d.db, { timeZone: zone });
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
    return (e as { code?: string }).code ?? String(e);
  }
};

async function planned(zone?: string) {
  const db = await device(zone);
  const project = await createProject(db, { name: "Thesis" });
  const task = await createTask(db, { title: "Write", projectId: project });
  const block = await createBlock(db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60, occurrenceDate: "2026-11-02" });
  const other = await createBlock(db, { taskId: task, date: "2026-11-02", startTime: "11:00", durationMinutes: 30 });
  return { db, project, task, block, other };
}

const row = async (db: Awaited<ReturnType<typeof device>>, type: string, id: string) => (await db.records.get([type, id]))!;

describe("2–3. drag edits", () => {
  it("a drag-move changes only that block: new instants, planning zone, refreshed snapshot; task and occurrence kept", async () => {
    const s = await planned();
    const otherBefore = await row(s.db, CALENDAR_BLOCKS, s.other);
    await updateTask(s.db, s.task, { title: "Write chapter 1" });
    await updateSharedPreferences(s.db, { timeZone: "Asia/Dubai" });
    const { previous, version } = await dragBlockTimes(s.db, s.block, { date: "2026-11-03", startTime: "10:15", durationMinutes: 60 });
    const data = (await row(s.db, CALENDAR_BLOCKS, s.block)).data as CalendarBlockData;
    expect(previous).toEqual({ startsAt: "2026-11-02T05:30:00.000Z", endsAt: "2026-11-02T06:30:00.000Z", timeZone: "Asia/Tehran", localDate: "2026-11-02" });
    expect(data).toMatchObject({
      startsAt: "2026-11-03T06:15:00.000Z", // 10:15 Dubai (UTC+4)
      endsAt: "2026-11-03T07:15:00.000Z",
      timeZone: "Asia/Dubai",
      localDate: "2026-11-03",
      taskId: s.task,
      occurrenceDate: "2026-11-02",
      status: "planned",
    });
    expect(data.snapshot.taskTitle).toBe("Write chapter 1");
    expect(version).toEqual((await row(s.db, CALENDAR_BLOCKS, s.block)).version);
    expect(await row(s.db, CALENDAR_BLOCKS, s.other)).toEqual(otherBefore);
  });

  it("a cancelled block cannot be dragged; a daylight-saving gap, zero, and over-24-hour durations are refused; nothing is written", async () => {
    const s = await planned("America/New_York");
    const before = await row(s.db, CALENDAR_BLOCKS, s.block);
    expect(await codeOf(dragBlockTimes(s.db, s.block, { date: "2026-03-08", startTime: "02:15", durationMinutes: 60 }))).toBe("DST_GAP");
    expect(await codeOf(dragBlockTimes(s.db, s.block, { date: "2026-11-02", startTime: "09:00", durationMinutes: 0 }))).toBe("INVALID_DURATION");
    expect(await codeOf(dragBlockTimes(s.db, s.block, { date: "2026-11-02", startTime: "09:00", durationMinutes: 24 * 60 + 15 }))).toBe("INVALID_DURATION");
    expect(await row(s.db, CALENDAR_BLOCKS, s.block)).toEqual(before);
    await setBlockCancelled(s.db, s.block, true);
    const cancelled = await row(s.db, CALENDAR_BLOCKS, s.block);
    expect(await codeOf(dragBlockTimes(s.db, s.block, { date: "2026-11-02", startTime: "10:00", durationMinutes: 60 }))).toBe("CANCELLED");
    expect(await row(s.db, CALENDAR_BLOCKS, s.block)).toEqual(cancelled);
  });

  it("dropping a block where it already is writes nothing and offers no undo", async () => {
    const s = await planned();
    const before = await row(s.db, CALENDAR_BLOCKS, s.block);
    const result = await dragBlockTimes(s.db, s.block, { date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    expect(result.version).toBeNull();
    expect(await row(s.db, CALENDAR_BLOCKS, s.block)).toEqual(before);
  });
});

describe("4b. Undo after a drag (T-090)", () => {
  it("writes the previous instants, zone, and local date back as a NEW version and refreshes the snapshot", async () => {
    const s = await planned();
    const original = await row(s.db, CALENDAR_BLOCKS, s.block);
    await updateSharedPreferences(s.db, { timeZone: "Asia/Dubai" });
    const drag = await dragBlockTimes(s.db, s.block, { date: "2026-11-02", startTime: "13:00", durationMinutes: 90 });
    await updateTask(s.db, s.task, { title: "Renamed" });
    await undoBlockTimes(s.db, s.block, drag.previous, drag.version!);
    const after = await row(s.db, CALENDAR_BLOCKS, s.block);
    const data = after.data as CalendarBlockData;
    expect(data).toMatchObject({ startsAt: "2026-11-02T05:30:00.000Z", endsAt: "2026-11-02T06:30:00.000Z", timeZone: "Asia/Tehran", localDate: "2026-11-02", occurrenceDate: "2026-11-02" });
    expect(data.snapshot.taskTitle).toBe("Renamed");
    // History moves forward: a higher version than both the original and the drag.
    const total = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0);
    expect(total(after.version)).toBe(total(original.version) + 2);
  });

  it("is refused when the block changed after the drag (version guard) or was cancelled; nothing is written", async () => {
    const s = await planned();
    const drag = await dragBlockTimes(s.db, s.block, { date: "2026-11-02", startTime: "13:00", durationMinutes: 60 });
    await updateBlock(s.db, s.block, { date: "2026-11-02", startTime: "14:00", durationMinutes: 60 }); // a form edit
    const edited = await row(s.db, CALENDAR_BLOCKS, s.block);
    expect(await codeOf(undoBlockTimes(s.db, s.block, drag.previous, drag.version!))).toBe("CHANGED");
    expect(await row(s.db, CALENDAR_BLOCKS, s.block)).toEqual(edited);

    const drag2 = await dragBlockTimes(s.db, s.other, { date: "2026-11-02", startTime: "15:00", durationMinutes: 30 });
    await setBlockCancelled(s.db, s.other, true);
    expect(await codeOf(undoBlockTimes(s.db, s.other, drag2.previous, drag2.version!))).toBe("CHANGED");
  });
});

describe("6. a color change writes only the project record (T-069)", () => {
  it("setting and clearing a color leaves blocks, tasks, and their versions unchanged; clearing removes the field", async () => {
    const s = await planned();
    const others = async () => (await s.db.records.toArray()).filter((r) => r.type !== PROJECTS).map((r) => [r.type, r.id, r.contentHash, r.version]);
    const before = await others();
    const created = await row(s.db, PROJECTS, s.project);
    expect(created.data).not.toHaveProperty("color");
    await updateProject(s.db, s.project, { color: "teal" });
    expect((await row(s.db, PROJECTS, s.project)).data.color).toBe("teal");
    await updateProject(s.db, s.project, { color: null });
    expect((await row(s.db, PROJECTS, s.project)).data).not.toHaveProperty("color");
    await updateProject(s.db, s.project, { name: "Thesis 2" }); // leaving color out keeps it absent
    expect((await row(s.db, PROJECTS, s.project)).data).not.toHaveProperty("color");
    expect(await others()).toEqual(before);
    expect(await codeOf(updateProject(s.db, s.project, { color: "magenta" as never }))).not.toBe("OK");
    const withColor = await createProject(s.db, { name: "Colored", color: "purple" });
    expect((await row(s.db, PROJECTS, withColor)).data.color).toBe("purple");
  });
});
