import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Ports that `fetch` refuses with "bad port" (the WHATWG Fetch "bad port" list, as in Node's
 * undici) from 1024 up, the ones `listen(0)` can return. On Windows the default dynamic range
 * can start at 1024 (here 1024–15000), so an ephemeral test server can land on one of these;
 * every request to it then fails with `TypeError: fetch failed` caused by `Error: bad port`.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * Starts a server with `listen` (normally `app.listen(0, "127.0.0.1")`) on a port `fetch` can
 * reach: a server given a blocked port is kept open while the next one starts, so the system
 * cannot hand the same port back, and closed once an allowed port is found.
 */
export async function listenForFetch(listen: () => Server): Promise<{ server: Server; port: number }> {
  const blocked: Server[] = [];
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const server = listen();
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      const { port } = server.address() as AddressInfo;
      if (!FETCH_BLOCKED_PORTS.has(port)) return { server, port };
      blocked.push(server);
    }
    throw new Error("no port that fetch accepts after 50 attempts");
  } finally {
    await Promise.all(blocked.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }
}
