/**
 * Task completions (DECISIONS T-108, T-118, T-119, T-133, T-134, T-147, T-155, T-156). Pure
 * helpers: the derived record ID and what is completed on which date. Nothing here writes.
 */
import { sha256Hex } from "../backup/sha256.ts";
import type { TaskCompletionData } from "../backup/registry.ts";
import { localDateOf } from "../planning/time.ts";

/**
 * The completion record ID of a one-off task (`occurrenceDate` null) or of one occurrence: a UUID
 * (version 8, RFC 9562) derived from the task ID and the occurrence date, so the same completion
 * made on two devices is one record and is counted once after a backup merge (T-119).
 */
export function completionId(taskId: string, occurrenceDate: string | null): string {
  const hex = sha256Hex(new TextEncoder().encode(`pps:taskCompletion:${taskId.toLowerCase()}:${occurrenceDate ?? "once"}`)).slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CompletionItem {
  id: string;
  data: TaskCompletionData;
}

/** A completion that counts: not reopened (T-133, T-147). */
export const isActiveCompletion = (c: CompletionItem) => c.data.reopenedAt === null;

/** Whether a one-off task is completed now. */
export function isTaskCompleted(completions: readonly CompletionItem[], taskId: string): boolean {
  return completions.some((c) => isActiveCompletion(c) && c.data.taskId === taskId && c.data.occurrenceDate === null);
}

/** Whether one occurrence of a recurring task is completed now. */
export function isOccurrenceCompleted(completions: readonly CompletionItem[], taskId: string, date: string): boolean {
  return completions.some((c) => isActiveCompletion(c) && c.data.taskId === taskId && c.data.occurrenceDate === date);
}

/**
 * The local date on which a completion is shown (T-134): an occurrence on its own date; a one-off
 * task on the actual local date it was completed, in the configured zone (T-156).
 */
export function completionDate(c: TaskCompletionData, zone: string): string {
  return c.occurrenceDate ?? localDateOf(c.completedAt, zone);
}

/** Completions shown on a local date, for the calendar and Today (T-134). */
export function completedOn(completions: readonly CompletionItem[], date: string, zone: string): CompletionItem[] {
  return completions.filter((c) => isActiveCompletion(c) && completionDate(c.data, zone) === date);
}

/**
 * Whether an occurrence dated `occurrenceDate` may be marked complete now: dated today or earlier
 * in the configured zone, at any time of that day (T-133, T-155).
 */
export function occurrenceHasHappened(occurrenceDate: string, zone: string, now: number = Date.now()): boolean {
  return occurrenceDate <= localDateOf(now, zone);
}
