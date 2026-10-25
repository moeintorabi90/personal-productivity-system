/**
 * Project colors (Stage 3 follow-up; DECISIONS T-068 to T-070, T-088, "Derived technical choices").
 * Pure presentation: a color is resolved on display from the CURRENT project record, so changing
 * a color writes only that project and no block or snapshot ever stores a color (T-069). Theme
 * values live in styles.css (`--pal-<id>-accent` / `--pal-<id>-tint`, and `neutral`).
 */
import { PALETTE_IDS, type PaletteId, type ProjectData, type TaskDefinitionData } from "../backup/registry.ts";

export { PALETTE_IDS, type PaletteId };

/** A palette entry, or the neutral color of items without a project (never stored). */
export type ColorKey = PaletteId | "neutral";

/** FNV-1a 32-bit over the UTF-8 bytes of `text`. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The derived default of a project without a chosen color: the same on every device; nothing is written. */
export function defaultColorOf(projectId: string): PaletteId {
  return PALETTE_IDS[fnv1a32(projectId.toLowerCase()) % PALETTE_IDS.length]!;
}

/** A project's color: its chosen palette entry, else the derived default. */
export function projectColor(projectId: string, data: Pick<ProjectData, "color"> | undefined): PaletteId {
  return data?.color ?? defaultColorOf(projectId);
}

/**
 * Color of a calendar item: the current project of its task; when the task is not on this device,
 * the project in the block's snapshot (its chosen color if that project is here, else its default);
 * neutral without a project.
 */
export function itemColor(
  item: { taskId: string; snapshotProjectId?: string | null },
  tasks: ReadonlyMap<string, Pick<TaskDefinitionData, "projectId">>,
  projects: ReadonlyMap<string, Pick<ProjectData, "color">>,
): ColorKey {
  const task = tasks.get(item.taskId);
  const projectId = task ? task.projectId : (item.snapshotProjectId ?? null);
  return projectId ? projectColor(projectId, projects.get(projectId)) : "neutral";
}
