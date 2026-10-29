import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { useServices } from "../app-context.tsx";
import { type Goals, loadGoals } from "../local/goals.ts";
import { loadOrganization, type Organization } from "../local/organization.ts";
import { loadWork, type WorkData } from "../local/work.ts";
import { TASK_COMPLETIONS, type TaskCompletionData } from "../backup/registry.ts";

/** All projects, workstreams, and task definitions on this device, kept live. */
export function useOrganization(): Organization | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadOrganization(db), [db]);
}

/** All goals and milestones on this device, kept live (Stage 4). */
export function useGoals(): Goals | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadGoals(db), [db]);
}

/** Stage 5 records (sessions, definitions, outputs, corrections, completions), kept live. */
export function useWork(): WorkData | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadWork(db), [db]);
}

/**
 * IDs of one-off tasks that are completed now (T-134: they leave the active-task list). Reads only
 * completion records, as every task row uses it.
 */
export function useCompletedTaskIds(): Set<string> {
  const { db } = useServices();
  const rows = useLiveQuery(() => db.records.where("type").equals(TASK_COMPLETIONS).toArray(), [db]);
  return useMemo(
    () => new Set((rows ?? []).map((r) => r.data as TaskCompletionData).filter((c) => c.reopenedAt === null && c.occurrenceDate === null).map((c) => c.taskId)),
    [rows],
  );
}
