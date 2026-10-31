/**
 * A session imported while running keeps its effective pause across further backups (DECISIONS
 * T-144, T-152, T-173; BACKUP_FORMAT "Data schema version 7"). The session record never changes by
 * importing or exporting. Fabricated data only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { updateSharedPreferences } from "../local/settings.ts";
import { endSession, loadWork, resumeSession, startSession, updateSessionDetails } from "../local/work.ts";
import { sessionState, workMinutes } from "../work/session-time.ts";
import { loadConflictViews, restoreReplacedVersion } from "./conflicts.ts";
import { contentHashOf } from "./envelope.ts";
import { DATA_SCHEMA_VERSION } from "./limits.ts";
import { PRODUCT_REGISTRY, type SessionData, SESSIONS } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
const time = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00.000Z`);
const devices: TestDevice[] = [];
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  await updateSharedPreferences(d.db, { timeZone: "Asia/Tehran" });
  return d;
}
const exportAt = async (d: TestDevice, at: Date) => (await exportFrom(d, { now: at }, registry)).text;
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const row = async (d: TestDevice, id: string) => (await d.db.records.get([SESSIONS, id]))!;
const dataOf = async (d: TestDevice, id: string) => (await row(d, id)).data as SessionData;
const markOf = async (d: TestDevice, id: string) => (await loadWork(d.db)).importedPaused[id];

/** A starts at 06:00 and exports at 07:00; B imports it. */
async function startedOnA() {
  const a = await device("A");
  const session = await startSession(a.db, {}, time("06:00").getTime());
  const first = await exportAt(a, time("07:00"));
  const b = await device("B");
  await importInto(b, first, product);
  return { a, b, session, first };
}

describe("an imported running session across further backups (T-173)", () => {
  it("A → B → C: the pause still begins at 07:00; C records 60 minutes of work, not 300; no record changes by import or export", async () => {
    const { a, b, session } = await startedOnA();
    const original = await row(a, session);
    expect(await markOf(b, session)).toBe(time("07:00").toISOString());

    const second = await exportAt(b, time("11:00"));
    const doc = JSON.parse(second);
    expect(doc.app.dataSchemaVersion).toBe(7);
    expect(doc.payload.importedSessionPauses).toEqual([{ sessionId: session, pausedFrom: time("07:00").toISOString() }]);
    expect(doc.payload.records[SESSIONS][0].data.pauses).toEqual([]);

    const c = await device("C");
    await importInto(c, second, product);
    for (const d of [b, c]) {
      const stored = await row(d, session);
      expect([stored.contentHash, stored.version]).toEqual([original.contentHash, original.version]);
    }
    expect(await markOf(c, session)).toBe(time("07:00").toISOString());
    const work = await loadWork(c.db);
    expect(sessionState(work.sessions[0]!.data, work.importedPaused[session])).toEqual({ kind: "paused", since: time("07:00").getTime(), imported: true });

    await endSession(c.db, session, {}, time("12:00").getTime());
    const ended = await dataOf(c, session);
    expect(ended.pauses).toEqual([{ start: time("07:00").toISOString(), end: time("12:00").toISOString() }]);
    expect(workMinutes(ended)).toBe(60);
  });

  it("a further device still gets 07:00; a backup made at 07:00:30 is carried as its whole minute", async () => {
    const a = await device("A");
    const session = await startSession(a.db, {}, time("06:00").getTime());
    const b = await device("B");
    await importInto(b, await exportAt(a, new Date("2026-11-02T07:00:30.000Z")), product);
    expect(await markOf(b, session)).toBe("2026-11-02T07:00:30.000Z");
    const c = await device("C");
    await importInto(c, await exportAt(b, time("11:00")), product);
    const d = await device("D");
    await importInto(d, await exportAt(c, time("11:30")), product);
    expect(await markOf(d, session)).toBe(time("07:00").toISOString());
  });

  it("once resumed or ended, later backups carry no metadata and rely on the stored pause", async () => {
    const { b, session } = await startedOnA();
    await resumeSession(b.db, session, time("11:30").getTime());
    expect((await dataOf(b, session)).pauses).toEqual([{ start: time("07:00").toISOString(), end: time("11:30").toISOString() }]);
    const resumed = JSON.parse(await exportAt(b, time("12:00")));
    expect(resumed.payload).not.toHaveProperty("importedSessionPauses");
    // Really running on B until 12:00, so the next device is paused from that backup's time.
    const c = await device("C");
    await importInto(c, JSON.stringify(resumed), product);
    await endSession(c.db, session, {}, time("13:00").getTime());
    expect(workMinutes(await dataOf(c, session))).toBe(90); // 06:00–07:00 and 11:30–12:00

    await endSession(b.db, session, {}, time("12:30").getTime());
    expect(JSON.parse(await exportAt(b, time("13:00"))).payload).not.toHaveProperty("importedSessionPauses");
  });

  it("a session running on the device that started it carries no metadata, and that device keeps running it", async () => {
    const { a, b, session } = await startedOnA();
    expect(JSON.parse(await exportAt(a, time("08:00"))).payload).not.toHaveProperty("importedSessionPauses");
    await importInto(a, await exportAt(b, time("11:00")), product);
    expect(await markOf(a, session)).toBeUndefined();
  });

  it("a device whose clock is behind keeps the pause at 07:00: C ends at 12:00 with 60 minutes of work", async () => {
    for (const clock of ["06:30", "05:00"]) {
      const { b, session } = await startedOnA();
      const behind = await exportAt(b, time(clock));
      expect(JSON.parse(behind).createdAt).toBe(time(clock).toISOString());
      expect(JSON.parse(behind).payload.importedSessionPauses).toEqual([{ sessionId: session, pausedFrom: time("07:00").toISOString() }]);
      const c = await device("C");
      await importInto(c, behind, product);
      expect(await markOf(c, session)).toBe(time("07:00").toISOString());
      await endSession(c.db, session, {}, time("12:00").getTime());
      const ended = await dataOf(c, session);
      expect(ended.pauses).toEqual([{ start: time("07:00").toISOString(), end: time("12:00").toISOString() }]);
      expect(workMinutes(ended)).toBe(60);
    }
  });

  it("an encrypted backup carries it too", async () => {
    const { b, session } = await startedOnA();
    const { text } = await exportFrom(b, { now: time("11:00"), password: "correct horse" }, registry);
    const c = await device("C");
    await importInto(c, text, { ...product, password: "correct horse" });
    expect(await markOf(c, session)).toBe(time("07:00").toISOString());
  });

  it("a session in a conflict keeps the carried pause when the backup's version is chosen, also through a further backup", async () => {
    const { a, b, session, first } = await startedOnA();
    const c = await device("C");
    await importInto(c, first, product);
    await updateSessionDetails(b.db, session, { notes: "from B" });
    await updateSessionDetails(c.db, session, { notes: "from C" });
    await importInto(c, await exportAt(b, time("11:00")), product);
    const [view] = await loadConflictViews(c.db, registry);
    expect(view!.conflict.incomingPausedFrom).toBe(time("07:00").toISOString());

    // Carried in C's next backup, with the same meaning on D.
    const d = await device("D");
    await importInto(d, first, product);
    await updateSessionDetails(d.db, session, { notes: "from D" });
    await importInto(d, await exportAt(c, time("11:30")), product);
    const carried = (await loadConflictViews(d.db, registry)).find((v) => v.conflict.conflictId === view!.conflict.conflictId)!;
    expect(carried.conflict.incomingPausedFrom).toBe(time("07:00").toISOString());

    await decide(c.db, view!.conflict.conflictId, "useBackup", registry);
    expect(await markOf(c, session)).toBe(time("07:00").toISOString());
    await endSession(c.db, session, {}, time("12:00").getTime());
    expect(workMinutes(await dataOf(c, session))).toBe(60);
    expect(await markOf(a, session)).toBeUndefined();
  });
});

describe("undo of an archived session version keeps its pause (T-173)", () => {
  const archivedOf = async (d: TestDevice, reason: string) => (await d.db.replacedVersions.toArray()).find((r) => r.type === SESSIONS && r.reason === reason)!;

  /** B treats the session as paused from 07:00. A (really running) and B both edit it; B imports A's backup made at 09:00. */
  async function conflictOnB() {
    const s = await startedOnA();
    await updateSessionDetails(s.a.db, s.session, { notes: "from A" });
    await updateSessionDetails(s.b.db, s.session, { notes: "from B" });
    await importInto(s.b, await exportAt(s.a, time("09:00")), product);
    const [view] = await loadConflictViews(s.b.db, registry);
    return { ...s, conflictId: view!.conflict.conflictId };
  }

  it("choosing the backup archives this device's version with 07:00; restoring it pauses from 07:00 and counts 60 minutes", async () => {
    const s = await conflictOnB();
    await decide(s.b.db, s.conflictId, "useBackup", registry);
    expect(await markOf(s.b, s.session)).toBe(time("09:00").toISOString());
    const archived = await archivedOf(s.b, "replacedByBackup");
    expect(archived.pausedFrom).toBe(time("07:00").toISOString());

    await restoreReplacedVersion(s.b.db, registry, archived.replacedId);
    expect((await dataOf(s.b, s.session)).notes).toBe("from B");
    expect((await dataOf(s.b, s.session)).pauses).toEqual([]);
    expect(await markOf(s.b, s.session)).toBe(time("07:00").toISOString());
    // The undo archived the other version with its own pause; undoing again brings 09:00 back.
    const undo = await archivedOf(s.b, "undo");
    expect(undo.pausedFrom).toBe(time("09:00").toISOString());

    await endSession(s.b.db, s.session, {}, time("12:00").getTime());
    expect(workMinutes(await dataOf(s.b, s.session))).toBe(60);
  });

  it("keeping this device's version archives the backup's with its pause; restoring it pauses from there", async () => {
    const s = await conflictOnB();
    await decide(s.b.db, s.conflictId, "keepDevice", registry);
    const archived = await archivedOf(s.b, "notChosen");
    expect(archived.pausedFrom).toBe(time("09:00").toISOString());
    await restoreReplacedVersion(s.b.db, registry, archived.replacedId);
    expect(await markOf(s.b, s.session)).toBe(time("09:00").toISOString());
    await endSession(s.b.db, s.session, {}, time("12:00").getTime());
    expect(workMinutes(await dataOf(s.b, s.session))).toBe(180);
  });

  it("an update applied from a backup archives the replaced version with its pause", async () => {
    const { a, b, session } = await startedOnA();
    await updateSessionDetails(a.db, session, { notes: "newer" });
    await importInto(b, await exportAt(a, time("09:00")), { ...product, applyUpdates: true });
    expect(await markOf(b, session)).toBe(time("09:00").toISOString());
    const archived = await archivedOf(b, "updatedFromBackup");
    expect(archived.pausedFrom).toBe(time("07:00").toISOString());
    await restoreReplacedVersion(b.db, registry, archived.replacedId);
    expect(await markOf(b, session)).toBe(time("07:00").toISOString());
  });

  it("the archive's pause travels in a backup, unchanged by a clock that is behind, and restores on another device", async () => {
    const s = await conflictOnB();
    await decide(s.b.db, s.conflictId, "useBackup", registry);
    const before = await archivedOf(s.b, "replacedByBackup");
    const text = await exportAt(s.b, time("06:30"));
    const c = await device("C");
    await importInto(c, text, product);
    const carried = (await c.db.replacedVersions.get(before.replacedId))!;
    expect(carried.pausedFrom).toBe(time("07:00").toISOString());
    expect(carried.entry).toEqual(before.entry); // the archived record itself is unchanged
    await restoreReplacedVersion(c.db, registry, carried.replacedId);
    expect(await markOf(c, s.session)).toBe(time("07:00").toISOString());
    await endSession(c.db, s.session, {}, time("12:00").getTime());
    expect(workMinutes(await dataOf(c, s.session))).toBe(60);
  });

  it("a version archived while really running has no pause on its device; on the next device it is paused from that backup's time", async () => {
    const { a, b, session } = await startedOnA();
    await updateSessionDetails(a.db, session, { notes: "from A" });
    await updateSessionDetails(b.db, session, { notes: "from B" });
    await importInto(a, await exportAt(b, time("09:00")), product);
    const [view] = await loadConflictViews(a.db, registry);
    await decide(a.db, view!.conflict.conflictId, "useBackup", registry);
    const own = await archivedOf(a, "replacedByBackup");
    expect(own.pausedFrom).toBeUndefined();
    const c = await device("C");
    await importInto(c, await exportAt(a, time("10:00")), product);
    const carried = (await c.db.replacedVersions.get(own.replacedId))!;
    expect(carried.pausedFrom).toBe(time("10:00").toISOString());
  });
});

describe("version 6 and validation of version-7 pause metadata (T-173)", () => {
  it("a version-6 backup keeps its behavior: a running session is paused from that backup's time", async () => {
    const a = await device("A");
    const session = await startSession(a.db, {}, time("06:00").getTime());
    const v6 = mutate(await exportAt(a, time("11:00")), (doc) => (doc.app.dataSchemaVersion = 6));
    const b = await device("B");
    await importInto(b, v6, product);
    expect(await markOf(b, session)).toBe(time("11:00").toISOString());
    await endSession(b.db, session, {}, time("12:00").getTime());
    expect(workMinutes(await dataOf(b, session))).toBe(300);

    const c = await device("C");
    expect(await codeOf(importInto(c, readFileSync(new URL("./samples/pps-backup-format-v1-data-v6.json", import.meta.url), "utf8"), product))).toBe("OK");
  });

  it("a version-6 file with the metadata, and a newer version, are refused", async () => {
    const { b } = await startedOnA();
    const text = await exportAt(b, time("11:00"));
    const c = await device("C");
    const before = await snapshot(c.db);
    expect(await codeOf(importInto(c, mutate(text, (doc) => (doc.app.dataSchemaVersion = 6)), product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(c, mutate(text, (doc) => (doc.app.dataSchemaVersion = DATA_SCHEMA_VERSION + 1)), product))).toBe("NEWER_VERSION");
    expect(await snapshot(c.db)).toEqual(before);
  });

  it("malformed or contradictory metadata refuses the whole file; nothing is imported", async () => {
    const { b, session } = await startedOnA();
    const text = await exportAt(b, time("11:00"));
    type Doc = { payload: { importedSessionPauses: { sessionId: string; pausedFrom: string; extra?: number }[] | unknown; records: Record<string, { data: Record<string, unknown>; contentHash: string }[]> } };
    const list = (doc: Doc) => doc.payload.importedSessionPauses as { sessionId: string; pausedFrom: string; extra?: number }[];
    const editSession = (doc: Doc, change: Record<string, unknown>) => {
      const env = doc.payload.records[SESSIONS]![0]!;
      Object.assign(env.data, change);
      env.contentHash = contentHashOf(env.data);
    };
    const cases: [string, (doc: Doc) => void][] = [
      ["seconds", (doc) => (list(doc)[0]!.pausedFrom = "2026-11-02T07:00:30.000Z")],
      ["no milliseconds form", (doc) => (list(doc)[0]!.pausedFrom = "2026-11-02T07:00:00Z")],
      ["an impossible date", (doc) => (list(doc)[0]!.pausedFrom = "2026-02-31T07:00:00.000Z")],
      ["not a string", (doc) => ((list(doc)[0] as unknown as { pausedFrom: number }).pausedFrom = 5)],
      ["a session not in the file", (doc) => (list(doc)[0]!.sessionId = crypto.randomUUID())],
      ["an unknown field", (doc) => (list(doc)[0]!.extra = 1)],
      ["a duplicate", (doc) => list(doc).push({ ...list(doc)[0]! })],
      ["an empty list", (doc) => (doc.payload.importedSessionPauses = [])],
      ["not a list", (doc) => (doc.payload.importedSessionPauses = { [session]: "x" })],
      ["before the session started", (doc) => (list(doc)[0]!.pausedFrom = time("05:00").toISOString())],
      ["an ended session", (doc) => editSession(doc, { endedAt: time("10:00").toISOString() })],
      ["a session with an open pause", (doc) => editSession(doc, { pauses: [{ start: time("06:30").toISOString(), end: null }] })],
      [
        "before the session's last activity",
        (doc) => editSession(doc, { pauses: [{ start: time("06:30").toISOString(), end: time("08:00").toISOString() }] }),
      ],
    ];
    const c = await device("C");
    const before = await snapshot(c.db);
    for (const [name, change] of cases) {
      expect(await codeOf(importInto(c, mutate(text, (doc) => change(doc as Doc)), product)), name).toBe("INVALID_PAYLOAD");
      expect(await snapshot(c.db), name).toEqual(before);
    }
  });

  it("contradictory metadata on a carried conflict refuses the whole file", async () => {
    const { b, session, first } = await startedOnA();
    const c = await device("C");
    await importInto(c, first, product);
    await updateSessionDetails(b.db, session, { notes: "from B" });
    await updateSessionDetails(c.db, session, { notes: "from C" });
    await importInto(c, await exportAt(b, time("11:00")), product);
    const text = await exportAt(c, time("11:30"));
    const d = await device("D");
    const before = await snapshot(d.db);
    const conflict = (doc: { payload: { pendingConflicts: { incomingPausedFrom?: string }[] } }) => doc.payload.pendingConflicts[0]!;
    for (const file of [
      mutate(text, (doc) => (conflict(doc).incomingPausedFrom = time("05:00").toISOString())), // before the session started
      mutate(text, (doc) => (conflict(doc).incomingPausedFrom = "2026-11-02T07:00:30.000Z")),
      mutate(text, (doc) => {
        doc.app.dataSchemaVersion = 6;
        delete doc.payload.importedSessionPauses;
      }),
    ]) {
      expect(await codeOf(importInto(d, file, product))).toBe("INVALID_PAYLOAD");
      expect(await snapshot(d.db)).toEqual(before);
    }
  });

  it("a pause later than the backup's own time is valid: device clocks can differ", async () => {
    const { b, session } = await startedOnA();
    const text = mutate(await exportAt(b, time("06:30")), (doc) => (doc.payload.importedSessionPauses[0].pausedFrom = time("08:00").toISOString()));
    const c = await device("C");
    expect(await codeOf(importInto(c, text, product))).toBe("OK");
    expect(await markOf(c, session)).toBe(time("08:00").toISOString());
  });

  it("invalid metadata on an archived version refuses the whole file; a version-6 file keeps its archive behavior", async () => {
    const s = await startedOnA();
    await updateSessionDetails(s.a.db, s.session, { notes: "from A" });
    await updateSessionDetails(s.b.db, s.session, { notes: "from B" });
    await importInto(s.b, await exportAt(s.a, time("09:00")), product);
    const [view] = await loadConflictViews(s.b.db, registry);
    await decide(s.b.db, view!.conflict.conflictId, "useBackup", registry);
    const text = await exportAt(s.b, time("10:00"));
    const row = (doc: { payload: { replacedVersions: { pausedFrom?: string; type: string }[] } }) => doc.payload.replacedVersions.find((r) => r.pausedFrom)!;
    const c = await device("C");
    const before = await snapshot(c.db);
    for (const file of [
      mutate(text, (doc) => (row(doc).pausedFrom = "2026-11-02T07:00:30.000Z")),
      mutate(text, (doc) => (row(doc).pausedFrom = time("05:00").toISOString())),
    ]) {
      expect(await codeOf(importInto(c, file, product))).toBe("INVALID_PAYLOAD");
      expect(await snapshot(c.db)).toEqual(before);
    }
    const asV6 = mutate(text, (doc) => {
      doc.app.dataSchemaVersion = 6;
      delete doc.payload.importedSessionPauses;
    });
    expect(await codeOf(importInto(c, asV6, product))).toBe("INVALID_PAYLOAD"); // version 7 fields in a version-6 file
    const legacy = mutate(asV6, (doc) => {
      for (const r of doc.payload.replacedVersions) delete r.pausedFrom;
    });
    expect(await codeOf(importInto(c, legacy, product))).toBe("OK");
    expect((await c.db.replacedVersions.toArray()).every((r) => r.pausedFrom === undefined)).toBe(true);
  });

  const v7Sample = new URL("./samples/pps-backup-format-v1-data-v7.json", import.meta.url);

  it("writes the dataSchemaVersion-7 sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    if (process.env.PPS_WRITE_SAMPLE !== "1" || (DATA_SCHEMA_VERSION as number) !== 7) return;
    const { b } = await startedOnA();
    const file = await exportFrom(b, { now: time("11:00"), backupId: "7c1e8f42-5a36-4d09-b7e2-3f9d6a1c8e54" }, registry);
    writeFileSync(v7Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-7 sample imports with its carried pause (fabricated data only)", async () => {
    const text = readFileSync(v7Sample, "utf8");
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(7);
    const { sessionId, pausedFrom } = doc.payload.importedSessionPauses[0];
    const c = await device("C");
    await importInto(c, text, product);
    expect(await markOf(c, sessionId)).toBe(pausedFrom);
  });
});
