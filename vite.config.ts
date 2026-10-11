import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";
// @ts-expect-error -- plain ESM, shared with the container entrypoint
import { injectConfig, normalizeProxyEntry, resolveConfig } from "./scripts/app-config.mjs";

/**
 * Resolves `config/` into the page as `window.__APP_CONFIG__`, for both the dev
 * server and the build. The container entrypoint redoes this on startup, so a
 * built image still takes its configuration from the environment.
 */
function appConfig(): Plugin {
  let isBuild = false;
  return {
    name: "app-config",
    configResolved: (resolved) => {
      isBuild = resolved.command === "build";
    },
    transformIndexHtml: {
      order: "post",
      // Serving is the real thing, so a broken config stops the dev server.
      // Building only produces a fallback — the entrypoint resolves it again,
      // strictly, against the environment the container actually runs in.
      handler: (html) => injectConfig(html, resolveConfig({ strict: !isBuild }).config)
    }
  };
}

/**
 * The dev server's half of the `proxy` map (path prefix → upstream base URL).
 * nginx does the same thing in the image, from the same key, so `api.baseUrl`
 * and `wfs.url` can stay same-origin in both: the browser only ever talks to
 * its own origin and CORS never comes into play. Restart `npm run dev` after
 * changing the map.
 */
function devProxy(proxy: Record<string, unknown>) {
  if (Object.keys(proxy).length === 0) return undefined;

  return Object.fromEntries(
    Object.entries(proxy).map(([prefix, entry]) => {
      const { url: upstream, headers, query } = normalizeProxyEntry(entry);
      const url = new URL(upstream);
      const basePath = url.pathname.replace(/\/$/, "");
      return [
        prefix,
        {
          target: url.origin,
          changeOrigin: true,
          secure: false,
          headers,
          // the prefix is replaced by the upstream's own path, and any extra
          // query the entry carries is appended — as nginx does in the image
          rewrite: (path: string) => {
            const rewritten = basePath + path.slice(prefix.length);
            if (!query) return rewritten;
            return rewritten + (rewritten.includes("?") ? "&" : "?") + query.replace(/^[?&]/, "");
          }
        }
      ];
    })
  );
}

export default defineConfig(({ command }) => ({
  plugins: [cesium(), react(), appConfig()],
  // Only the dev server uses the proxy map; nginx renders it in the image.
  server: { port: 5173, proxy: devProxy(resolveConfig({ strict: command === "serve" }).proxy) },
  build: { outDir: "dist", sourcemap: true }
}));
