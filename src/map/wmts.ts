import TileLayer from 'ol/layer/Tile';
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS';
import WMTSCapabilities from 'ol/format/WMTSCapabilities';
import OSM from 'ol/source/OSM';
import TileState from 'ol/TileState';
import type ImageTile from 'ol/ImageTile';
import type Tile from 'ol/Tile';
import { credentialHeaders, type WmtsConfig } from '../config';

/** A layer entry as it appears in a capabilities document. */
interface CapabilitiesLayer {
  Identifier: string;
  TileMatrixSetLink?: { TileMatrixSet: string }[];
  ResourceURL?: { resourceType?: string; format?: string; template?: string }[];
}

interface Capabilities {
  Contents?: {
    Layer?: CapabilitiesLayer[];
    TileMatrixSet?: { Identifier: string; TileMatrix?: { Identifier: string }[] }[];
  };
}

function readCapabilities(body: string): Capabilities | null {
  return new WMTSCapabilities().read(body) as Capabilities | null;
}

function withKey(url: string, cfg: WmtsConfig): string {
  if (!cfg.apiKey || !cfg.apiKeyParam) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${cfg.apiKeyParam}=${encodeURIComponent(cfg.apiKey)}`;
}

function authTileLoader(headers: Record<string, string>) {
  return (tile: Tile, src: string) => {
    const image = (tile as ImageTile).getImage() as HTMLImageElement;
    fetch(src, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        image.src = url;
      })
      .catch(() => tile.setState(TileState.ERROR));
  };
}

export interface WmtsDescriptor {
  template: string;
  matrixSet: string;
  labels: string[];
  format: string;
}

export async function wmtsDescriptor(cfg: WmtsConfig, capabilitiesUrl: string, layer: string): Promise<WmtsDescriptor | null> {
  const headers = cfg.apiKeyParam ? {} : credentialHeaders(cfg);
  const res = await fetch(withKey(capabilitiesUrl, cfg), { headers });
  if (!res.ok) return null;
  const caps = readCapabilities(await res.text());
  const entry = (caps?.Contents?.Layer ?? []).find((l) => l.Identifier === layer);
  if (!entry) return null;

  const matrixSet = cfg.matrixSet || entry.TileMatrixSetLink?.[0]?.TileMatrixSet;
  if (!matrixSet) return null;
  const set = (caps?.Contents?.TileMatrixSet ?? []).find((m) => m.Identifier === matrixSet);
  const resource = (entry.ResourceURL ?? []).find((r) => r.resourceType === 'tile' && (!cfg.format || r.format === cfg.format));
  if (!set || !resource?.template) return null;

  return {
    template: withKey(resource.template.replace('{TileMatrixSet}', matrixSet), cfg),
    matrixSet,
    labels: (set.TileMatrix ?? []).map((m) => m.Identifier),
    format: resource.format ?? cfg.format ?? 'image/jpeg',
  };
}

/** The layer's own first matrix set, so it does not have to be configured. */
function matrixSetFor(caps: Capabilities, layer: string) {
  const entry = (caps.Contents?.Layer ?? []).find((l) => l.Identifier === layer);
  return entry?.TileMatrixSetLink?.[0]?.TileMatrixSet;
}

/**
 * Build the base tile layer. If a WMTS capabilities URL is configured, the
 * source is derived from it; otherwise (and if allowed) OSM is used so the app
 * still works out of the box during local development. Null when neither is
 * configured — a map with no base layer is a valid setup offline.
 */
export async function createBaseLayer(cfg: WmtsConfig): Promise<TileLayer | null> {
  if (cfg.capabilitiesUrl) {
    return createWmtsLayer(cfg, cfg.capabilitiesUrl, cfg.layer);
  }

  if (cfg.osmFallback) {
    return new TileLayer({ source: new OSM() });
  }
  // Neither configured is a valid choice, not a failure — on a disconnected
  // network there is no base map to be had, and results draw over nothing.
  return null;
}

/**
 * A WMTS layer from any capabilities document — the configured one, or one a
 * catalog record pointed at. Upstreams are called directly, with no proxy in
 * front. An <img> cannot carry a header, so when the key is a header the tile
 * is fetched and handed on as a blob; with apiKeyParam it rides in the query
 * string and loads straight into the <img>.
 */
export async function createWmtsLayer(cfg: WmtsConfig, capabilitiesUrl: string, layer: string): Promise<TileLayer> {
  const url = withKey(capabilitiesUrl, cfg);
  const headers = cfg.apiKeyParam ? {} : credentialHeaders(cfg);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`WMTS capabilities fetch failed (HTTP ${res.status})`);
  }

  const body = await res.text();
  const caps = readCapabilities(body);

  // A 200 that is not a capabilities document is the common case: an error
  // page, or this app's own index.html when the URL is a path nginx does not
  // proxy and the SPA fallback answers it. Say so — OpenLayers would only
  // report that it cannot read "Layer" of undefined.
  if (!caps?.Contents?.Layer) {
    const looksLikeHtml = /^\s*(<!doctype html|<html)/i.test(body);
    throw new Error(
      looksLikeHtml
        ? `${url} returned an HTML page, not WMTS capabilities — check the URL reaches the WMTS and is not falling through to the app itself`
        : `${url} did not return a WMTS capabilities document`
    );
  }

  const options = optionsFromCapabilities(caps, {
    layer,
    matrixSet: cfg.matrixSet || matrixSetFor(caps, layer),
    style: cfg.style || undefined,
    format: cfg.format || undefined,
  });
  if (!options) {
    const available = caps.Contents.Layer.map((l) => l.Identifier);
    throw new Error(`WMTS layer "${layer}" not found at ${url}. Available: ${available.join(', ')}`);
  }

  const hasHeader = Object.keys(headers).length > 0;
  return new TileLayer({
    source: new WMTS({
      ...options,
      urls: (options.urls ?? []).map((u) => withKey(u, cfg)),
      crossOrigin: 'anonymous',
      ...(hasHeader ? { tileLoadFunction: authTileLoader(headers) } : {}),
    }),
  });
}
