/**
 * Deletions that travel together (BACKUP_FORMAT "Showing and resolving conflicts"; D-015): a
 * session, its output, and their correction records emptied from the trash on one device arrive
 * on the other as separate "deleted in the backup" decisions. Restrict holds in every order —
 * nothing is deleted without its own decision — and the list, the refusal, and the bulk action
 * make the right order findable. Fabricated data only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { updateSharedPreferences } from "../local/settings.ts";
import { addOutputs, correctOutputValue, createOutputDefinition, deleteSession, purgeTrash, recordPastSession } from "../local/work.ts";
import { type ConflictView, loadConflictViews, ResolutionError, resolveConflict, resolveConflicts } from "./conflicts.ts";
import { CORRECTIONS, OUTPUT_RECORDS, PRODUCT_REGISTRY, SESSIONS } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { exportFrom, importInto, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const T0 = Date.parse("2026-11-02T06:00:00Z");
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
const exportText = async (d: TestDevice) => (await exportFrom(d, {}, registry)).text;
const key = (v: ConflictView) => `${v.conflict.type}/${v.conflict.id}`;

/**
 * Device B has a session with one output and two correction records (one for the added output,
 * one for its corrected value; both link to the session and the output). Device A empties them
 * from its trash; its backup is imported on B. Returns B, A's backup, and the IDs.
 */
async function deletedElsewhere() {
  const a = await device("A");
  const b = await device("B");
  const definition = await createOutputDefinition(a.db, { name: "Pages", unit: "pages" });
  const session = await recordPastSession(a.db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30 }, T0);
  const [output] = await addOutputs(a.db, session, [{ definitionId: definition, value: 5 }]);
  await correctOutputValue(a.db, output!, 6, "typo");
  await importInto(b, await exportText(a), { registry });
  await deleteSession(a.db, session, T0);
  await purgeTrash(a.db, { emptyNow: true, now: T0 });
  const backup = await exportText(a);
  await importInto(b, backup, { registry });
  const views = await loadConflictViews(b.db, registry);
  const corrections = views.filter((v) => v.conflict.type === CORRECTIONS).map((v) => v.conflict.id);
  return { b, backup, session, output: output!, corrections, views };
}

/** Tries "Delete it here too" on one pending decision exactly as the UI does; returns the refusal code or "OK". */
async function deleteHere(d: TestDevice, type: string, id: string): Promise<string> {
  const view = (await loadConflictViews(d.db, registry)).find((v) => v.conflict.type === type && v.conflict.id === id);
  if (!view) return "NO_DECISION";
  try {
    await resolveConflict(d.db, registry, view.conflict.conflictId, "deleteHere", view.token);
    return "OK";
  } catch (e) {
    return (e as ResolutionError).code;
  }
}

const live = async (d: TestDevice, type: string, id: string) => !!(await d.db.records.get([type, id]));

/** Every order of the four decisions (24). */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("deletions of linked records from a backup (restrict, D-015)", () => {
  it("arrive as one decision per record; the list puts every blocker's decision before the record it blocks", async () => {
    const { session, output, corrections, views } = await deletedElsewhere();
    expect(views.map(key).sort()).toEqual(
      [`${SESSIONS}/${session}`, `${OUTPUT_RECORDS}/${output}`, ...corrections.map((c) => `${CORRECTIONS}/${c}`)].sort(),
    );
    expect(views.every((v) => v.conflict.incoming.deleted && v.options.join() === "deleteHere,keepHere")).toBe(true);
    const at = (k: string) => views.findIndex((v) => key(v) === k);
    for (const c of corrections) expect(at(`${CORRECTIONS}/${c}`)).toBeLessThan(at(`${OUTPUT_RECORDS}/${output}`));
    expect(at(`${OUTPUT_RECORDS}/${output}`)).toBeLessThan(at(`${SESSIONS}/${session}`));
    // The session names all three blockers, each with its own pending decision.
    const sessionView = views.find((v) => v.conflict.type === SESSIONS)!;
    expect(sessionView.blockedBy.map((i) => `${i.type}/${i.id}`).sort()).toEqual(
      [`${OUTPUT_RECORDS}/${output}`, ...corrections.map((c) => `${CORRECTIONS}/${c}`)].sort(),
    );
    const decisionIds = new Set(views.map((v) => v.conflict.conflictId));
    expect(sessionView.blockedBy.every((i) => i.conflictId !== null && decisionIds.has(i.conflictId))).toBe(true);
    expect(views.filter((v) => v.conflict.type === CORRECTIONS).every((v) => v.blockedBy.length === 0)).toBe(true);
  });

  it("the session first: refused, naming what still belongs to it; nothing changes and the other decisions stay", async () => {
    const { b, session, output, corrections } = await deletedElsewhere();
    const before = await snapshot(b.db);
    const view = (await loadConflictViews(b.db, registry)).find((v) => v.conflict.type === SESSIONS)!;
    const error = await resolveConflict(b.db, registry, view.conflict.conflictId, "deleteHere", view.token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResolutionError);
    expect((error as ResolutionError).code).toBe("HAS_LINKED_ITEMS");
    expect((error as ResolutionError).linkedItems.map((i) => `${i.type}/${i.id}`).sort()).toEqual(
      [`${OUTPUT_RECORDS}/${output}`, ...corrections.map((c) => `${CORRECTIONS}/${c}`)].sort(),
    );
    expect(await snapshot(b.db)).toEqual(before);
    expect(await live(b, SESSIONS, session)).toBe(true);
  });

  it("in every order, only decided records go, each refusal changes nothing, and a second pass completes; the tombstones stay", async () => {
    const orders = permutations(["session", "output", "correction0", "correction1"]);
    expect(orders).toHaveLength(24);
    for (const order of orders) {
      const { b, backup, session, output, corrections } = await deletedElsewhere();
      const target: Record<string, [string, string]> = {
        session: [SESSIONS, session],
        output: [OUTPUT_RECORDS, output],
        correction0: [CORRECTIONS, corrections[0]!],
        correction1: [CORRECTIONS, corrections[1]!],
      };
      const deleted = new Set<string>();
      for (const name of order) {
        const [type, id] = target[name]!;
        const before = await snapshot(b.db);
        const code = await deleteHere(b, type, id);
        if (code === "OK") deleted.add(name);
        else {
          expect(code, order.join(" → ")).toBe("HAS_LINKED_ITEMS");
          expect(await snapshot(b.db), order.join(" → ")).toEqual(before);
        }
        // Never more than what was decided: every other record is still here.
        for (const [other, [t, i]] of Object.entries(target)) expect(await live(b, t, i), `${order.join(" → ")}: ${other}`).toBe(!deleted.has(other));
      }
      // The user follows the list (blockers first) for whatever is left.
      for (const view of await loadConflictViews(b.db, registry)) {
        await resolveConflict(b.db, registry, view.conflict.conflictId, "deleteHere", view.token);
      }
      expect(await b.db.pendingConflicts.count()).toBe(0);
      const tombstones = (await b.db.tombstones.toArray()).map((t) => `${t.type}/${t.id}`);
      for (const [t, i] of Object.values(target)) expect(tombstones).toContain(`${t}/${i}`);
      // The same backup again changes nothing; the next backup carries every tombstone.
      const again = await importInto(b, backup, { registry });
      expect(again.preview.items.filter((i) => i.category !== "alreadyHere" && i.category !== "olderCopy")).toEqual([]);
      expect(await b.db.pendingConflicts.count()).toBe(0);
      const carried = JSON.parse(await exportText(b)).payload.tombstones.map((t: { type: string; id: string }) => `${t.type}/${t.id}`);
      for (const [t, i] of Object.values(target)) expect(carried).toContain(`${t}/${i}`);
    }
  });

  it("deciding from the top of the list never meets a refusal", async () => {
    const { b } = await deletedElsewhere();
    for (const view of await loadConflictViews(b.db, registry)) {
      expect(await deleteHere(b, view.conflict.type, view.conflict.id)).toBe("OK");
    }
    expect(await b.db.records.where("type").anyOf(SESSIONS, OUTPUT_RECORDS, CORRECTIONS).count()).toBe(0);
  });

  it("keeping the output keeps the session blocked: the output is named as kept, and the session can still be kept", async () => {
    const { b, session, output, corrections } = await deletedElsewhere();
    for (const c of corrections) expect(await deleteHere(b, CORRECTIONS, c)).toBe("OK");
    const outputView = (await loadConflictViews(b.db, registry)).find((v) => v.conflict.type === OUTPUT_RECORDS)!;
    await resolveConflict(b.db, registry, outputView.conflict.conflictId, "keepHere", outputView.token);
    const sessionView = (await loadConflictViews(b.db, registry)).find((v) => v.conflict.type === SESSIONS)!;
    expect(sessionView.blockedBy).toEqual([{ type: OUTPUT_RECORDS, id: output, conflictId: null }]);
    expect(await deleteHere(b, SESSIONS, session)).toBe("HAS_LINKED_ITEMS");
    await resolveConflict(b.db, registry, sessionView.conflict.conflictId, "keepHere", sessionView.token);
    expect(await live(b, SESSIONS, session)).toBe(true);
    expect(await live(b, OUTPUT_RECORDS, output)).toBe(true);
    expect(await b.db.pendingConflicts.count()).toBe(0);
  });

  it("a bulk choice skips a refused decision with its reason and still applies the others in one transaction", async () => {
    const { b, session, output, corrections, views } = await deletedElsewhere();
    // Parent first, as an unsorted caller might pass them.
    const shown = [...views].reverse().map((v) => ({ conflictId: v.conflict.conflictId, expected: v.token }));
    expect(views.at(-1)!.conflict.type).toBe(SESSIONS);
    const result = await resolveConflicts(b.db, registry, shown, "deleteHere");
    // The session is blocked by all three, the output by the corrections; the corrections go.
    expect(result.resolved).toBe(2);
    expect(result.skipped.map((s) => s.error.code)).toEqual(["HAS_LINKED_ITEMS", "HAS_LINKED_ITEMS"]);
    expect(result.skipped[0]!.error.linkedItems.map((i) => i.id).sort()).toEqual([output, ...corrections].sort());
    expect(result.skipped[1]!.error.linkedItems.map((i) => i.id).sort()).toEqual([...corrections].sort());
    expect(await live(b, SESSIONS, session)).toBe(true);
    expect(await live(b, OUTPUT_RECORDS, output)).toBe(true);
    for (const c of corrections) expect(await live(b, CORRECTIONS, c)).toBe(false);
    // The skipped decisions are still there, in the list's order (output, then session), and now go through.
    const left = await loadConflictViews(b.db, registry);
    expect(left.map((v) => v.conflict.type)).toEqual([OUTPUT_RECORDS, SESSIONS]);
    const again = await resolveConflicts(b.db, registry, left.map((v) => ({ conflictId: v.conflict.conflictId, expected: v.token })), "deleteHere");
    expect(again).toEqual({ resolved: 2, skipped: [] });
    expect(await b.db.pendingConflicts.count()).toBe(0);
  });
});
