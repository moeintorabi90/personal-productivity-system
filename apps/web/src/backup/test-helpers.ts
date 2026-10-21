/** TEST-ONLY helpers for backup tests. */
import { createHash } from "node:crypto";
import type { LocalDb } from "../local/db.ts";
import { type ConflictView, loadConflictViews, type Resolution, resolveConflict } from "./conflicts.ts";
import { createBackup, type ExportOptions } from "./export.ts";
import { canonicalize } from "./jcs.ts";
import { applyImport, type ImportChoices, previewImport } from "./merge.ts";
import { openBackupFile } from "./read.ts";
import type { Registry } from "./registry.ts";
import { TEST_REGISTRY, type TestDevice } from "./test-fixtures.ts";

export const blobOf = (text: string) => new Blob([text]);

/** The conflict as the UI shows it now (current device version, token, options). */
export async function viewOf(db: LocalDb, conflictId: string, registry: Registry = TEST_REGISTRY): Promise<ConflictView> {
  const view = (await loadConflictViews(db, registry)).find((v) => v.conflict.conflictId === conflictId);
  if (!view) throw new Error(`no conflict ${conflictId}`);
  return view;
}

/** Resolves a conflict exactly as the UI does: with the token of the version that was shown. */
export async function decide(db: LocalDb, conflictId: string, resolution: Resolution, registry: Registry = TEST_REGISTRY) {
  const view = await viewOf(db, conflictId, registry);
  await resolveConflict(db, registry, conflictId, resolution, view.token);
}

export async function exportFrom(device: TestDevice, options: ExportOptions = {}, registry: Registry = TEST_REGISTRY) {
  return createBackup(device.db, registry, options);
}

export async function importInto(
  device: TestDevice,
  text: string,
  options: Partial<ImportChoices> & { password?: string; registry?: Registry } = {},
) {
  const registry = options.registry ?? TEST_REGISTRY;
  const opened = await openBackupFile(blobOf(text), registry, options.password);
  const preview = await previewImport(device.db, opened, registry);
  const result = await applyImport(device.db, opened, registry, {
    applyUpdates: options.applyUpdates ?? false,
    applyDisplaySettings: options.applyDisplaySettings ?? false,
  });
  return { opened, preview, result };
}

/** Deterministic view of everything import may touch. */
export async function snapshot(db: LocalDb) {
  const records = (await db.records.toArray())
    .map((r) => `${r.type}/${r.id}#${r.contentHash}@${canonicalize(r.version)}${r.copyOf ? `~${r.copyOf}` : ""}`)
    .sort();
  const tombstones = (await db.tombstones.toArray()).map((t) => `${t.type}/${t.id}@${canonicalize(t.version)}`).sort();
  const pending = (await db.pendingConflicts.toArray()).map((c) => `${c.kind}:${c.type}/${c.id}`).sort();
  const replaced = await db.replacedVersions.count();
  const settings = (await db.meta.get("deviceSettings"))?.value ?? null;
  return { records, tombstones, pending, replaced, settings };
}

/** Recomputes the integrity hash with Node's crypto (independent of the app's implementation). */
export function rehash(doc: Record<string, unknown>): string {
  const { integrity: _omit, ...rest } = doc;
  doc.integrity = {
    algorithm: "SHA-256",
    canonicalization: "JCS-RFC8785",
    hash: createHash("sha256").update(canonicalize(rest), "utf8").digest("hex"),
  };
  return JSON.stringify(doc);
}

export function mutate(text: string, change: (doc: any) => void, recomputeIntegrity = true): string {
  const doc = JSON.parse(text);
  change(doc);
  return recomputeIntegrity ? rehash(doc) : JSON.stringify(doc);
}
