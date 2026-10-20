/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sync API origin. Empty (default) means same origin, proxied to the API in development. */
  readonly VITE_API_BASE_URL?: string;
}
