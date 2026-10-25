import { useLiveQuery } from "dexie-react-hooks";
import { useServices } from "../app-context.tsx";
import { type Goals, loadGoals } from "../local/goals.ts";
import { loadOrganization, type Organization } from "../local/organization.ts";

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
