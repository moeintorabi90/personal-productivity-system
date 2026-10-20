// Resolves the repository's internal packages for Node at runtime (DECISIONS T-014).
// The project lives on an exFAT drive, which cannot hold the symlinks npm workspaces need.
// Usage: node --import ./tools/node-aliases.mjs apps/api/src/server.ts
import { registerHooks } from "node:module";

const aliases = {
  "@pps/shared": new URL("../packages/shared/src/index.ts", import.meta.url).href,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = aliases[specifier];
    if (target) return { url: target, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
