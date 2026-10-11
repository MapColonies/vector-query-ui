/**
 * Resolves the app configuration the way node-config does, and injects it into
 * index.html.
 *
 * The app is a static bundle — there is no server process to read `config/` at
 * runtime — so the resolved document is written into the page as
 * `window.__APP_CONFIG__` and read from there on startup. The dev server and
 * the build do this through vite.config.ts; the container entrypoint does it
 * again at startup, which is what makes the environment (and therefore a
 * ConfigMap) able to reconfigure an already-built image.
 *
 * Precedence (later wins):
 *   1. config/default.json
 *   2. config/{NODE_ENV}.json          (development / production / ...)
 *   3. config/local.json               (optional, git-ignored, per-machine)
 *   4. environment variables mapped in config/custom-environment-variables.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything between these is replaced, markers included, so it can be redone. */
export const CONFIG_START = '<!-- app-config -->';
export const CONFIG_END = '<!-- /app-config -->';

export class ConfigError extends Error {}

const fail = (message) => {
  throw new ConfigError(message);
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars are replaced wholesale. */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`could not read ${file}: ${e.message}`);
  }
}

/** Minimal .env support so `npm run dev` picks up local overrides too. */
function loadDotEnv(file, env) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    // real environment variables always win over the file
    if (!(key in env)) env[key] = value;
  }
}

function coerce(name, value, format) {
  switch (format) {
    case 'boolean': {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'off'].includes(v)) return false;
      return fail(`${name}="${value}" is not a boolean`);
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return fail(`${name}="${value}" is not a number`);
      return n;
    }
    case 'json':
      try {
        return JSON.parse(value);
      } catch (e) {
        return fail(`${name} is not valid JSON: ${e.message}`);
      }
    case undefined:
    case 'string':
      return value;
    default:
      return fail(`unsupported __format "${format}" for ${name}`);
  }
}

/**
 * Walks the mapping tree; a leaf is either an env var name or a
 * `{ "__name": "VAR", "__format": "boolean|number|json" }` descriptor.
 */
function fromEnvironment(mapping, env, path = [], applied = []) {
  const out = {};
  for (const [key, spec] of Object.entries(mapping)) {
    const here = [...path, key];
    if (typeof spec === 'string' || (isPlainObject(spec) && '__name' in spec)) {
      const name = typeof spec === 'string' ? spec : spec.__name;
      const format = typeof spec === 'string' ? undefined : spec.__format;
      const raw = env[name];
      // an unset or empty variable leaves the underlying default alone
      if (raw === undefined || raw === '') continue;
      out[key] = coerce(name, raw, format);
      applied.push(`${name} → ${here.join('.')}`);
    } else if (isPlainObject(spec)) {
      // `applied` is shared across the recursion, so only the values matter here
      const { values } = fromEnvironment(spec, env, here, applied);
      if (Object.keys(values).length > 0) out[key] = values;
    } else {
      fail(`invalid mapping at ${here.join('.')} in custom-environment-variables.json`);
    }
  }
  return { values: out, applied };
}

function validate(cfg, warn, strict) {
  const errors = [];
  const at = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg);
  const requireString = (path) => {
    const v = at(path);
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${path} must be a non-empty string`);
  };
  const requireNumber = (path) => {
    const v = at(path);
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${path} must be a number`);
  };

  /**
   * The three endpoints the browser calls. Each may be absolute
   * (`https://host/path`, needs CORS on the target) or same-origin
   * (`/path`, when an ingress serves the app and the service together).
   */
  const requireUrl = (path, envVar) => {
    requireString(path);
    const v = at(path);
    if (typeof v !== 'string' || v.trim() === '') return;
    if (!/^https?:\/\//i.test(v) && !v.startsWith('/')) {
      errors.push(`${path} must be an absolute http(s) URL or start with "/" (got "${v}")`);
    } else if (/example\.com/i.test(v)) {
      warn(`⚠ config: ${path} is still the placeholder "${v}" — set ${envVar}`);
    }
  };

  // layers metadata API — the layer-list endpoint itself: GET {baseUrl} and
  // GET {baseUrl}/{name}, so any "/layers"-style path belongs in the URL.
  // Optional: without one, the app reads layer metadata from the WFS itself
  // (GetCapabilities / DescribeFeatureType).
  if (at('api.baseUrl')) requireUrl('api.baseUrl', 'API_BASE_URL');

  // WFS — GetFeature is POSTed here
  requireUrl('wfs.url', 'WFS_URL');
  requireString('wfs.srsName');
  requireString('wfs.featureNS');
  requireString('wfs.featurePrefix');

  // named alternative GeoServers offered as a runtime picker
  const servers = at('wfs.servers');
  if (servers !== undefined) {
    if (!Array.isArray(servers)) {
      errors.push('wfs.servers must be an array of { name, url, apiBaseUrl? }');
    } else {
      servers.forEach((server, i) => {
        if (!isPlainObject(server)) {
          errors.push(`wfs.servers[${i}] must be an object`);
          return;
        }
        if (typeof server.name !== 'string' || server.name.trim() === '') {
          errors.push(`wfs.servers[${i}].name must be a non-empty string`);
        }
        requireUrl(`wfs.servers.${i}.url`, 'WFS_SERVERS');
        if (server.apiBaseUrl) requireUrl(`wfs.servers.${i}.apiBaseUrl`, 'WFS_SERVERS');
      });
    }
  }
  if (at('wfs.maxFeatures') !== undefined) {
    const max = at('wfs.maxFeatures');
    if (!Number.isInteger(max) || max <= 0) errors.push('wfs.maxFeatures must be a positive integer');
  }

  // WMTS — either a GetCapabilities document (with a layer) or the OSM fallback
  if (at('wmts.capabilitiesUrl')) {
    requireUrl('wmts.capabilitiesUrl', 'WMTS_CAPABILITIES_URL');
    if (!at('wmts.layer')) errors.push('wmts.layer is required when wmts.capabilitiesUrl is set');
  } else if (at('wmts.osmFallback') !== true) {
    // A deliberate choice on a disconnected network, where OpenStreetMap is
    // unreachable anyway: the map still draws query results, over nothing.
    warn('⚠ config: no wmts.capabilitiesUrl and osmFallback is off — the map will have no base layer');
  }

  // map
  requireString('map.projection');
  requireNumber('map.zoom');
  const center = at('map.center');
  if (!Array.isArray(center) || center.length !== 2 || !center.every((n) => typeof n === 'number')) {
    errors.push('map.center must be [x, y] in map.projection units');
  }
  const projections = at('map.customProjections');
  if (projections !== undefined && !isPlainObject(projections)) {
    errors.push('map.customProjections must be an object of EPSG code → proj4 definition');
  }

  // proxy — prefix → upstream, used by the dev server and by nginx in the image
  const proxy = at('proxy');
  if (proxy !== undefined) {
    if (!isPlainObject(proxy)) {
      errors.push('proxy must be an object of path prefix → upstream');
    } else {
      for (const [prefix, entry] of Object.entries(proxy)) {
        if (!prefix.startsWith('/')) errors.push(`proxy key "${prefix}" must start with "/"`);
        const url = isPlainObject(entry) ? entry.url : entry;
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
          errors.push(`proxy["${prefix}"] needs an absolute http(s) url (got "${url}")`);
        }
        if (isPlainObject(entry) && entry.headers !== undefined && !isPlainObject(entry.headers)) {
          errors.push(`proxy["${prefix}"].headers must be an object of header → value`);
        }
      }
    }
  }

  // ui
  requireString('ui.title');
  if (!['rtl', 'ltr'].includes(at('ui.direction'))) errors.push('ui.direction must be "rtl" or "ltr"');

  if (at('wfs.srsName') && at('map.projection') && at('wfs.srsName') !== at('map.projection')) {
    warn(`⚠ config: wfs.srsName (${at('wfs.srsName')}) differs from map.projection (${at('map.projection')}) — features may land in the wrong place`);
  }

  if (errors.length === 0) return;
  const report = `invalid configuration\n${errors.map((e) => `    - ${e}`).join('\n')}`;
  // The build machine is not the deployment: what it injects is only the
  // fallback for a page nobody reconfigured, and the entrypoint resolves the
  // real thing at startup. So say so, but do not fail the image over it.
  if (!strict) return warn(`⚠ config: ${report}`);
  fail(report);
}

/**
 * Resolves the layers into one document. Throws ConfigError if the result would
 * not run — a broken config fails the build or the container, never the user.
 */
export function resolveConfig({ configDir = join(ROOT, 'config'), env = process.env, warn = console.warn, strict = true } = {}) {
  const dir = resolve(configDir);
  const nodeEnv = env.NODE_ENV || 'development';

  loadDotEnv(join(ROOT, '.env'), env);

  const defaultsFile = join(dir, 'default.json');
  if (!existsSync(defaultsFile)) fail(`${defaultsFile} not found`);

  const sources = ['default.json'];
  let cfg = readJson(defaultsFile);

  for (const name of [`${nodeEnv}.json`, 'local.json']) {
    const file = join(dir, name);
    if (existsSync(file)) {
      cfg = deepMerge(cfg, readJson(file));
      sources.push(name);
    }
  }

  const mappingFile = join(dir, 'custom-environment-variables.json');
  let applied = [];
  if (existsSync(mappingFile)) {
    const fromEnv = fromEnvironment(readJson(mappingFile), env);
    applied = fromEnv.applied;
    cfg = deepMerge(cfg, fromEnv.values);
  }

  validate(cfg, warn, strict);

  // The proxy map is for whatever serves the app — the dev server or nginx —
  // and never reaches the browser, so it is handed back separately.
  // `devProxy` is the name the README uses; both are accepted, and `proxy`
  // wins per prefix. Merged rather than picked, because default.json ships an
  // empty `proxy` — a `??` chain would never reach `devProxy`.
  const proxy = { ...(cfg.devProxy ?? {}), ...(cfg.proxy ?? {}) };
  delete cfg.proxy;
  delete cfg.devProxy;

  routeUpstreamsThroughProxy(cfg, proxy);

  return { config: cfg, proxy, sources, applied, nodeEnv };
}

/**
 * The endpoints the app calls through its own origin. Each is configured as
 * one thing: the service's real URL, optionally with a key held server-side.
 *
 * WMTS needs one extra step. A capabilities document advertises absolute tile
 * URLs on the WMTS's own host, so tiles would go straight there and miss both
 * the proxy and its key. `tileProxy` hands the client what it needs to point
 * those back here — see src/map/wmts.ts.
 */
const UPSTREAMS = [
  { name: 'api', prefix: '/api-proxy', section: 'api', url: 'baseUrl' },
  { name: 'wfs', prefix: '/wfs-proxy', section: 'wfs', url: 'url' },
  { name: 'csw', prefix: '/csw-proxy', section: 'wmts', url: 'cswUrl', keyFrom: 'wmts' },
  // Whichever names the raster host: the catalog's products live on it, and so
  // do the tiles. `serviceUrl` wins, since with a catalog there is no single
  // capabilities document to point at.
  { name: 'wmts', prefix: '/wmts-proxy', section: 'wmts', url: 'serviceUrl', tiles: true },
  { name: 'wmts', prefix: '/wmts-proxy', section: 'wmts', url: 'capabilitiesUrl', tiles: true },
];

/**
 * Rewrites every absolute upstream to a path on this app's own origin and adds
 * the matching proxy entry, so the browser only ever calls the server that
 * served it. That is what makes CORS a non-issue and lets a key be attached:
 * a key cannot be given to the browser — it would sit in the page for anyone
 * to read, and OpenLayers has nowhere to put a header on a tile request — so
 * it is held here and applied on the way out.
 *
 * The whole host is mapped rather than the one path, so the tile URLs a WMTS
 * capabilities document hands back are covered too.
 */
function routeUpstreamsThroughProxy(cfg, proxy) {
  // `direct` trades the proxy away: upstreams keep their absolute URLs and the
  // browser calls them itself, so every one of them must send CORS headers.
  // The keys stay in the page, which is the point and the cost — anyone with
  // the page has them. WMTS tiles are the exception that does not survive the
  // trade: OpenLayers cannot put a header on a tile request, so a raster host
  // wanting a key still needs the proxy.
  if (cfg.direct) return;

  // Keys come off first: one section can be routed under several prefixes —
  // the catalog and the raster host are both "wmts" — and each needs the key.
  const keys = {};
  for (const section of new Set(UPSTREAMS.map((u) => u.section))) {
    const conf = cfg[section];
    if (!conf) continue;
    keys[section] = { key: conf.apiKey, header: conf.apiKeyHeader || 'x-api-key' };
    // never let a key reach the page, whether or not it ends up being used
    delete conf.apiKey;
    delete conf.apiKeyHeader;
    delete conf.tileProxy;
  }

  for (const { prefix, section, url: urlKey, tiles } of UPSTREAMS) {
    const conf = cfg[section];
    if (!conf) continue;

    const value = conf[urlKey];
    // a relative one is already same-origin, and someone else is routing it
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;

    const url = new URL(value);
    const claimed = proxy[prefix];
    // serviceUrl claims /wmts-proxy before capabilitiesUrl does; a second URL
    // on the same host just rides along, one somewhere else cannot be routed
    if (claimed && claimed.url !== url.origin) continue;

    if (!claimed) {
      const { key, header } = keys[section] ?? {};
      proxy[prefix] = { url: url.origin, ...(key ? { headers: { [header]: key } } : {}) };
    }
    // a bare host has pathname "/", which would double up the separator
    const path = url.pathname === '/' ? '' : url.pathname;
    conf[urlKey] = `${prefix}${path}${url.search}`;
    if (tiles) conf.tileProxy = { prefix, origin: url.origin };
  }

  // Alternative GeoServers: each absolute endpoint gets a prefix of its own,
  // so every server can carry its own key without sharing it with the others.
  // A server that names no key inherits the base one, like every other wfs
  // setting — `wfs.apiKey` for its WFS, `api.apiKey` for its metadata API.
  // Relative URLs are already same-origin — someone else is routing those.
  const servers = Array.isArray(cfg.wfs?.servers) ? cfg.wfs.servers : [];
  servers.forEach((server, i) => {
    if (!isPlainObject(server)) return;
    const own = server.apiKey ? { key: server.apiKey, header: server.apiKeyHeader || 'x-api-key' } : null;
    delete server.apiKey;
    delete server.apiKeyHeader;

    const route = (urlKey, prefix, inherited) => {
      const value = server[urlKey];
      if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
      const url = new URL(value);
      const { key, header = 'x-api-key' } = own ?? inherited ?? {};
      proxy[prefix] = { url: url.origin, ...(key ? { headers: { [header]: key } } : {}) };
      const path = url.pathname === '/' ? '' : url.pathname;
      server[urlKey] = `${prefix}${path}${url.search}`;
    };
    route('url', `/wfs-server-${i + 1}`, keys.wfs);
    route('apiBaseUrl', `/wfs-server-${i + 1}-api`, keys.api);
  });
}

/**
 * An entry is either a bare upstream URL or `{ url, headers, query }`, where
 * `headers` and `query` are attached to every proxied request — how a WMTS or
 * an API that wants a token gets one.
 */
export function normalizeProxyEntry(entry) {
  const { url, headers = {}, query = '' } = typeof entry === 'string' ? { url: entry } : entry;
  return { url, headers, query };
}

/**
 * `${VAR}` from the process environment, so secrets stay out of the config.
 *
 * An unset variable is fatal rather than empty: silently sending `x-api-key: ""`
 * upstream turns a missing Secret into a 401 from the far end, which looks like
 * a credentials problem and is nothing of the sort.
 */
function expandEnv(value, env, where) {
  return String(value).replace(/\$\{(\w+)\}/g, (_, name) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      fail(`${where} refers to \${${name}}, which is not set in the environment`);
    }
    return resolved;
  });
}

const quoted = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;

/**
 * nginx `location` blocks for the proxy map, included by nginx.conf. Same deal
 * as the dev server: the browser only ever talks to its own origin, so CORS
 * never applies and an upstream that sends no CORS headers still works.
 *
 * The trailing slash on both the location and proxy_pass is what swaps the
 * prefix for the upstream's own path: /api/layers → https://upstream/layers.
 *
 * A token belongs here rather than in the app config: this file is only ever
 * read by nginx, so the credential is never served to the browser.
 */
export function renderNginxProxy(proxy, env = process.env) {
  const blocks = Object.entries(proxy).map(([prefix, entry]) => {
    const { url: rawUrl, headers, query } = normalizeProxyEntry(entry);
    const at = `proxy["${prefix}"]`;
    const url = new URL(expandEnv(rawUrl, env, `${at}.url`));
    const base = url.pathname.replace(/\/$/, '');
    const location = prefix.endsWith('/') ? prefix : `${prefix}/`;

    const lines = [`location ${location} {`];

    // append to the request's own query string, keeping whatever was already there
    if (query) {
      const extra = expandEnv(query, env, `${at}.query`).replace(/^[?&]/, '');
      lines.push(
        `    set $upstream_args ${quoted(extra)};`,
        `    if ($args) { set $upstream_args "$args&${extra}"; }`,
        `    set $args $upstream_args;`
      );
    }

    lines.push(
      `    proxy_pass ${url.origin}${base}/;`,
      // the upstream routes on Host, and TLS on SNI
      `    proxy_set_header Host ${url.host};`,
      `    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
      // A WMTS builds the URLs it advertises from these, so ours must not
      // reach it: told it is served over "$scheme" at this app's hostname, it
      // writes exactly that into every ResourceURL, and the tiles come back
      // pointing at us instead of at itself. Cleared rather than corrected —
      // an empty value removes the header, and the upstream's own edge fills
      // them in with the truth. That also stops the inbound pair from a router
      // in front of us being appended to, which is what produces the
      // "http, https" scheme in an advertised URL.
      `    proxy_set_header X-Forwarded-Proto "";`,
      `    proxy_set_header X-Forwarded-Host "";`,
      `    proxy_set_header X-Forwarded-Port "";`,
      `    proxy_set_header Forwarded "";`,
      `    proxy_http_version 1.1;`
    );
    if (url.protocol === 'https:') lines.push(`    proxy_ssl_server_name on;`);

    // last, so an explicit Host or Authorization wins over the defaults above
    for (const [name, value] of Object.entries(headers)) {
      const resolved = expandEnv(value, env, `${at}.headers.${name}`);
      lines.push(`    proxy_set_header ${name} ${quoted(resolved)};`);
    }

    lines.push('}');
    return lines.join('\n');
  });

  return `# generated on startup from the proxy map — do not edit\n${blocks.join('\n\n')}\n`;
}

/**
 * Replaces the marked block in `html`, keeping the markers so a container that
 * restarts can rewrite a page that was already written to.
 */
export function injectConfig(html, config) {
  const start = html.indexOf(CONFIG_START);
  const end = html.indexOf(CONFIG_END);
  if (start === -1 || end === -1) {
    fail(`index.html is missing the ${CONFIG_START} … ${CONFIG_END} block`);
  }
  const script = `<script>window.__APP_CONFIG__ = ${JSON.stringify(config)};</script>`;
  return html.slice(0, start) + `${CONFIG_START}${script}${CONFIG_END}` + html.slice(end + CONFIG_END.length);
}
