import { fileURLToPath } from "node:url";

/** Internal package aliases shared by Vite and Vitest (see DECISIONS T-014). */
export const aliases = {
  "@pps/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
  "@pps/api": fileURLToPath(new URL("./apps/api/src/index.ts", import.meta.url)),
};
