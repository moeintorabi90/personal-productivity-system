import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { FETCH_BLOCKED_PORTS, listenForFetch } from "./listen.ts";

const respond = () => createServer((_req, res) => res.end("ok"));
const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

describe("test servers listen on a port fetch accepts", () => {
  it("fetch refuses every blocked port before connecting: no server needs to listen there", async () => {
    for (const port of FETCH_BLOCKED_PORTS) {
      const error = await fetch(`http://127.0.0.1:${port}/`).then(() => null, (e: Error) => e);
      expect(String(error)).toBe("TypeError: fetch failed");
      expect(String((error as Error & { cause?: unknown }).cause)).toBe("Error: bad port");
    }
  });

  it("listenForFetch skips a candidate on a blocked port, closes it, and returns the next server, which fetch reaches", async () => {
    const calls: Server[] = [];
    const { server, port } = await listenForFetch(() => {
      const s = respond().listen(0, "127.0.0.1");
      // The first candidate reports a blocked port, as the system may assign; its real port is ephemeral.
      if (calls.length === 0) s.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 10080 }) satisfies AddressInfo;
      calls.push(s);
      return s;
    });
    try {
      expect(calls).toHaveLength(2);
      expect(calls[0]!.listening).toBe(false); // skipped and closed
      expect(server).toBe(calls[1]);
      expect(FETCH_BLOCKED_PORTS.has(port)).toBe(false);
      expect(port).toBe((server.address() as AddressInfo).port);
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    } finally {
      await close(server);
    }
  });
});
