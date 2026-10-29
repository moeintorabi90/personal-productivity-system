/**
 * Goal progress inputs (DECISIONS T-116; T-047 to T-049, T-100 to T-106, T-122 to T-133, T-137,
 * T-143, T-159). Calculated from records, never stored; shown from Stage 6 (ROADMAP), so Stage 5
 * only computes and tests these values. Attribution is what each record stores now (T-127,
 * T-131), never recalculated from a task's current links (T-132); goal dates and status do not
 * filter anything (T-046, T-101). Values beyond the target are returned in full (T-106).
 */
import type { GoalData, OutputRecordData, SessionData, TaskCompletionData } from "../backup/registry.ts";
import { workMinutes } from "./session-time.ts";

export interface ProgressRecords {
  sessions: readonly { id: string; data: SessionData }[];
  outputs: readonly { id: string; data: OutputRecordData }[];
  completions: readonly { id: string; data: TaskCompletionData }[];
}

/**
 * Progress of one goal in its own measure: work minutes (time goals; ended sessions only, so an
 * open timer is not counted until it ends), the sum of attributed output values of the goal's
 * definition (output goals), or the number of completions (task-count goals). Sessions in the
 * trash, their outputs, separately deleted outputs, reopened completions, and expected amounts
 * never count (T-125, T-133, T-142, T-143).
 */
export function goalProgress(goalId: string, goal: GoalData, records: ProgressRecords): number {
  const liveSessions = new Map(records.sessions.filter((s) => s.data.deletedAt === null).map((s) => [s.id, s.data]));
  switch (goal.kind) {
    case "time": {
      let minutes = 0;
      for (const s of liveSessions.values()) if (s.goalId === goalId && s.endedAt !== null) minutes += workMinutes(s);
      return minutes;
    }
    case "output": {
      if (!goal.definitionId) return 0;
      let total = 0;
      for (const o of records.outputs) {
        const d = o.data;
        if (d.deletedAt === null && liveSessions.has(d.sessionId) && d.definitionId === goal.definitionId && d.goalIds.includes(goalId)) total += d.value;
      }
      return total;
    }
    case "taskCount":
      return records.completions.filter((c) => c.data.reopenedAt === null && c.data.goalId === goalId).length;
  }
}
