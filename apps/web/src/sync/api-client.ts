import {
  apiErrorBodySchema,
  type ErrorCode,
  type LoginRequest,
  type PullResponse,
  pullResponseSchema,
  type PushResponse,
  pushResponseSchema,
  type SessionResponse,
  sessionResponseSchema,
  type SetupRequest,
  setupStatusResponseSchema,
  type SyncOperation,
} from "@pps/shared";
import type { z } from "zod";

/** The server answered with a structured error. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly fieldErrors: Record<string, string[]> | undefined;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.fieldErrors = fieldErrors;
  }
}

/** The server could not be reached (offline, DNS, refused, aborted, or malformed response). */
export class NetworkError extends Error {
  constructor(message = "Network request failed") {
    super(message);
    this.name = "NetworkError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  token: string | null = null;

  constructor(baseUrl = "", fetchImpl?: FetchLike) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async #request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S | null,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new NetworkError();
    }

    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A proxy or offline page answered instead of the API.
      throw new NetworkError(`Unexpected response (${response.status})`);
    }

    if (!response.ok) {
      const parsed = apiErrorBodySchema.safeParse(json);
      if (parsed.success) {
        const e = parsed.data.error;
        throw new ApiRequestError(response.status, e.code, e.message, e.details, e.fieldErrors);
      }
      if (response.status >= 500 || response.status === 404) throw new NetworkError(`Server error (${response.status})`);
      throw new ApiRequestError(response.status, "INTERNAL", `Unexpected error (${response.status})`);
    }
    if (!schema) return undefined as z.output<S>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new NetworkError("Response did not match the API contract");
    return parsed.data;
  }

  setupStatus() {
    return this.#request("GET", "/v1/setup/status", setupStatusResponseSchema);
  }

  setup(body: SetupRequest, setupToken?: string): Promise<SessionResponse> {
    return this.#request("POST", "/v1/setup", sessionResponseSchema, {
      body,
      headers: setupToken ? { "x-setup-token": setupToken } : {},
    });
  }

  login(body: LoginRequest): Promise<SessionResponse> {
    return this.#request("POST", "/v1/auth/session", sessionResponseSchema, { body });
  }

  async logout(): Promise<void> {
    await this.#request("DELETE", "/v1/auth/session", null);
  }

  push(operations: SyncOperation[]): Promise<PushResponse> {
    return this.#request("POST", "/v1/sync/push", pushResponseSchema, { body: { operations } });
  }

  pull(cursor: string | null, limit = 200): Promise<PullResponse> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    return this.#request("GET", `/v1/sync/pull?${qs}`, pullResponseSchema);
  }
}
