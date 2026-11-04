import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { FETCH_BLOCKED_PORTS, listenForFetch } from "./listen.ts";

describe("test servers listen on a port fetch accepts", () => {
  it("fetch refuses a blocked port, and listenForFetch skips it and closes that server", async () => {
    const respond = () => createServer((_req, res) => res.end("ok"));
    // 10080 is on fetch's list and inside this machine's dynamic range (1024–15000).
    expect(FETCH_BLOCKED_PORTS.has(10080)).toBe(true);
    const calls: Server[] = [];
    const { server, port } = await listenForFetch(() => {
      const s = respond().listen(calls.length === 0 ? 10080 : 0, "127.0.0.1");
      calls.push(s);
      return s;
    });
    try {
      expect(calls).toHaveLength(2);
      expect(port).not.toBe(10080);
      expect(calls[0]!.listening).toBe(false); // the blocked one is closed
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
      // What the skipped server would have given: the error seen in the full suite.
      const blocked = respond().listen(10080, "127.0.0.1");
      await new Promise<void>((resolve) => blocked.once("listening", () => resolve()));
      const error = await fetch("http://127.0.0.1:10080/").then(() => null, (e: Error) => e);
      await new Promise<void>((resolve) => blocked.close(() => resolve()));
      expect(String(error)).toBe("TypeError: fetch failed");
      expect(String((error as Error & { cause?: unknown }).cause)).toBe("Error: bad port");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
