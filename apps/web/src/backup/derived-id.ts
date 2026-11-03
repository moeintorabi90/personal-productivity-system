/**
 * Record IDs derived from what a record is about (UUID version 8, RFC 9562), so the same record
 * written on two devices has one ID and merges as one (T-119 pattern). Stage 6 uses them for
 * estimate captures, app-use dates, weekly allocations and plans, and choice-history events.
 */
import { sha256Hex } from "./sha256.ts";

export function derivedUuid(text: string): string {
  const hex = sha256Hex(new TextEncoder().encode(text)).slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The estimate captured for one occurrence of a task (`null`: a one-off task), T-189. */
export const estimateCaptureId = (taskId: string, occurrenceDate: string | null) =>
  derivedUuid(`pps:taskEstimateCapture:${taskId.toLowerCase()}:${occurrenceDate ?? "once"}`);

/** One app-use date (T-203 to T-205). */
export const appUseDayId = (date: string) => derivedUuid(`pps:appUseDay:${date}`);

/** A goal's manual allocation of one calendar week (T-206). */
export const weekAllocationId = (goalId: string, weekStart: string) => derivedUuid(`pps:goalWeekAllocation:${goalId.toLowerCase()}:${weekStart}`);

/** A goal's recorded plan of one calendar week (T-208, T-225). */
export const weekPlanId = (goalId: string, weekStart: string) => derivedUuid(`pps:goalWeekPlan:${goalId.toLowerCase()}:${weekStart}`);

/** One owner decision for a weekly-plan date (T-237). */
export const planChoiceId = (goalId: string, weekStart: string, from: string, device: string, seq: number) =>
  derivedUuid(`pps:goalWeekPlanChoice:${goalId.toLowerCase()}:${weekStart}:${from}:${device.toLowerCase()}:${seq}`);
