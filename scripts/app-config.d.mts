export const ROOT: string;
export const CONFIG_START: string;
export const CONFIG_END: string;
export function deepMerge<T>(base: T, override: unknown): T;
export function injectConfig(html: string, config: unknown): string;
export function normalizeProxyEntry(entry: string | { url: string; headers?: Record<string, string>; query?: string }): {
  url: string;
  headers: Record<string, string>;
  query: string;
};
export function renderNginxProxy(proxy: Record<string, unknown>, env?: NodeJS.ProcessEnv): string;
export function resolveConfig(options?: { strict?: boolean }): { config: Record<string, unknown> };
