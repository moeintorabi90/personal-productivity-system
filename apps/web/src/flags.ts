/**
 * Build-time flag for the frozen post-v1 sync code (D-016, T-019). Off by default: v1 shows no
 * account/sync screens or "Sync check notes" and never starts the sync engine. Only a developer
 * build with VITE_ENABLE_FROZEN_SYNC=true turns it on, for experiments with the frozen code.
 */
export const FROZEN_SYNC_ENABLED = import.meta.env.VITE_ENABLE_FROZEN_SYNC === "true";
