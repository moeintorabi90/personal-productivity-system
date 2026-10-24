import { useLiveQuery } from "dexie-react-hooks";
import { useServices } from "../app-context.tsx";
import { loadOrganization, type Organization } from "../local/organization.ts";

/** All projects, workstreams, and task definitions on this device, kept live. */
export function useOrganization(): Organization | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadOrganization(db), [db]);
}
