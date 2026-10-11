import defaults from '../config/default.json';

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
}

export interface MapConfig {
  projection: string;
  center: [number, number];
  zoom: number;
  /** Extra projections as proj4 definitions, keyed by EPSG code. */
  customProjections?: Record<string, string>;
}

export interface WmtsConfig {
  /**
   * CSW catalog. Every raster product publishes its own
   * capabilities document, so this is how the base-map picker finds them.
   * Takes precedence over `capabilitiesUrl` when both are set.
   */
  cswUrl?: string;
  /**
   * Base URL of the WMTS service the catalog's products are served from.
   * Needed so capabilities and tiles can be proxied and keyed — the catalog
   * hands back absolute URLs on this host.
   */
  serviceUrl?: string;
  /**
   * Catalog products stacked on the map, bottom first — up to three, so a
   * transparent overlay can sit on an ortho. Defaults to the first product
   * the catalog returns.
   */
  productIds?: string[];
  /** URL of the WMTS GetCapabilities document. Leave empty to use the OSM fallback. */
  capabilitiesUrl: string;
  layer: string;
  matrixSet?: string;
  style?: string;
  format?: string;
  /** Show an OpenStreetMap base layer when no WMTS is configured (useful for local dev). */
  osmFallback?: boolean;
  /**
   * Key for the tile service. With `apiKeyParam` it rides in the query string,
   * so tiles load straight into an <img> and each request is its own entry in
   * the network log. Without it the key is a header, which an <img> cannot
   * carry, so tiles have to be fetched and passed on as blobs.
   */
  apiKey?: string;
  apiKeyHeader?: string;
  apiKeyParam?: string;
}

/**
 * An alternative WFS endpoint the user can switch to at runtime. Anything not
 * set here is taken from the base `wfs` config. `apiBaseUrl` names the layers
 * metadata API for this server; without one, metadata is read from the WFS
 * itself (GetCapabilities / DescribeFeatureType). `apiKey` never reaches the
 * page — the config script strips it and holds it at the proxy.
 */
export interface WfsServer {
  name: string;
  url: string;
  /**
   * Layers metadata API for this server, if it has one — the layer-list
   * endpoint itself, path included (e.g. "https://api.example.com/layers").
   */
  apiBaseUrl?: string;
  version?: string;
  srsName?: string;
  featureNS?: string;
  featurePrefix?: string;
  geometryName?: string;
  apiKey?: string;
  apiKeyHeader?: string;
}

export interface WfsConfig {
  url: string;
  version?: string;
  srsName: string;
  featureNS: string;
  featurePrefix: string;
  geometryName?: string;
  maxFeatures?: number;
  /** Named GeoServers to offer as a picker; empty means just `url`. */
  servers?: WfsServer[];
  apiKey?: string;
  apiKeyHeader?: string;
}

export interface HistoryConfig {
  enabled: boolean;
  /** Suffix of the feature type unioning live rows with their history. */
  versionedSuffix: string;
  validFromProperty: string;
  validToProperty: string;
  /** Columns identifying one feature across versions; the first present wins. */
  identityProperties: string[];
}

export interface UiConfig {
  title: string;
  direction: 'rtl' | 'ltr';
  /** Text of the warning banner on the map's corner; empty hides it. */
  disclaimer?: string;
}

export interface AppConfig {
  api: ApiConfig;
  map: MapConfig;
  wmts: WmtsConfig;
  wfs: WfsConfig;
  ui: UiConfig;
  /** Upstreams are called directly; keys travel in the page. */
  direct?: boolean;
  history?: HistoryConfig;
  /**
   * Three-dimensional geometry: the globe behind the 2D/3D toggle, and the
   * per-feature viewer in the panel. Off hides both entirely, and the Cesium
   * globe is never constructed.
   */
  threeD?: { enabled: boolean; extrude?: { from: string; to: string } };
}

/** Baked-in defaults — the same `config/default.json` the config script starts from. */
export const defaultConfig = defaults as unknown as AppConfig;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars are replaced wholesale. */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override ?? base) as T;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out as T;
}

declare global {
  interface Window {
    __APP_CONFIG__?: Partial<AppConfig>;
  }
}

/**
 * The resolved `config/` document, written into index.html as
 * `window.__APP_CONFIG__` — by vite when serving or building, and again by the
 * container entrypoint on startup, which is how one image takes its settings
 * from the environment it is deployed into.
 *
 * Merged over the compiled-in defaults, so a page that somehow missed the
 * injection still runs on `config/default.json`.
 */
export function loadConfig(): AppConfig {
  return deepMerge(defaultConfig, window.__APP_CONFIG__ ?? {});
}

/**
 * The key header for an upstream, when one reached the page. Empty unless
 * `direct` is on — otherwise the build strips keys and the proxy adds them.
 */
export function credentialHeaders(source?: { apiKey?: string; apiKeyHeader?: string }): Record<string, string> {
  if (!source?.apiKey) return {};
  return { [source.apiKeyHeader || 'x-api-key']: source.apiKey };
}
