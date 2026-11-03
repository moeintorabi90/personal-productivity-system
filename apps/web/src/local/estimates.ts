/**
 * Estimate captures (DECISIONS T-189, T-190; derived "Estimate capture"): each task occurrence keeps
 * the task's estimate at the moment it is first planned, or, if unplanned, when its first session
 * starts or is assigned to it. A later estimate edit applies only to occurrences captured later.
 * Nothing is back-filled: occurrences from before version 8 have no capture ("no data").
 */
import { estimateCaptureId } from "../backup/derived-id.ts";
import { type Registry, TASK_DEFINITIONS, TASK_ESTIMATE_CAPTURES, type TaskDefinitionData, type TaskEstimateCaptureData } from "../backup/registry.ts";
import type { LocalDb } from "./db.ts";
import { putRecord } from "./records.ts";

/**
 * The occurrence key of a planned or worked item: `null` for a one-off task, the occurrence date
 * for a recurring one; `undefined` when a recurring task's item has no occurrence (nothing to capture).
 */
export function occurrenceKey(task: TaskDefinitionData, occurrenceDate: string | null | undefined): string | null | undefined {
  if (!task.recurrence) return null;
  return occurrenceDate ?? undefined;
}

/** Captures the task's current estimate for an occurrence once; inside the caller's transaction. */
export async function captureEstimate(
  db: LocalDb,
  registry: Registry,
  taskId: string,
  occurrenceDate: string | null | undefined,
  source: TaskEstimateCaptureData["source"],
  now: number = Date.now(),
): Promise<void> {
  if (!registry.get(TASK_ESTIMATE_CAPTURES)) return;
  const task = (await db.records.get([TASK_DEFINITIONS, taskId]))?.data as TaskDefinitionData | undefined;
  if (!task || task.estimateMinutes === null) return; // a task with no estimate captures none
  const key = occurrenceKey(task, occurrenceDate);
  if (key === undefined) return;
  const id = estimateCaptureId(taskId, key);
  if ((await db.records.get([TASK_ESTIMATE_CAPTURES, id])) || (await db.tombstones.get([TASK_ESTIMATE_CAPTURES, id]))) return;
  const data: TaskEstimateCaptureData = { taskId, occurrenceDate: key, estimateMinutes: task.estimateMinutes, capturedAt: new Date(now).toISOString(), source };
  await putRecord(db, registry, TASK_ESTIMATE_CAPTURES, id, data);
}
