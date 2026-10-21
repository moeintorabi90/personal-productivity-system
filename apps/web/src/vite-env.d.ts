/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sync API origin. Empty (default) means same origin, proxied to the API in development. */
  readonly VITE_API_BASE_URL?: string;
  /** "true" enables the frozen post-v1 sync screens and engine (development only, D-016). */
  readonly VITE_ENABLE_FROZEN_SYNC?: string;
}
