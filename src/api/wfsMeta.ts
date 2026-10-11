/**
 * Layer metadata straight from the WFS, for when the layers API is down or a
 * server has no such API at all: GetCapabilities stands in for the layer list,
 * DescribeFeatureType for the property list. Poorer metadata — no aliases, no
 * possible values — but every WFS can answer it.
 */
import { credentialHeaders } from '../config';
import type { LayersApiLike } from './client';
import type { LayerDetail, LayerProperty, LayersResponse } from './types';

async function fetchXml(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<Document> {
  const res = await fetch(url, { signal, headers });
  if (!res.ok) throw new Error(`WFS metadata request failed (HTTP ${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('WFS did not return an XML document');
  }
  const exception = doc.querySelector('ExceptionText, ServiceException')?.textContent.trim();
  if (exception) throw new Error(`WFS: ${exception}`);
  return doc;
}

/** All elements with this local name, whatever namespace prefix the server used. */
function byLocalName(root: ParentNode & Node, name: string): Element[] {
  return Array.from((root as Document | Element).getElementsByTagName('*')).filter((el) => el.localName === name);
}

export class WfsMetaApi implements LayersApiLike {
  public constructor(
    private readonly wfsUrl: string,
    private readonly credential?: { apiKey?: string; apiKeyHeader?: string }
  ) {}

  private url(params: Record<string, string>): string {
    const url = new URL(this.wfsUrl, window.location.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  public async listLayers(signal?: AbortSignal): Promise<LayersResponse> {
    const doc = await fetchXml(this.url({ service: 'WFS', request: 'GetCapabilities' }), signal, credentialHeaders(this.credential));
    const layers = byLocalName(doc, 'FeatureType').flatMap((ft) => {
      const name = ft.getElementsByTagName('Name').item(0)?.textContent.trim();
      if (!name) return [];
      const title = ft.getElementsByTagName('Title').item(0)?.textContent.trim();
      // The advertised name is namespace-qualified ("core:roads"); the rest of
      // the app carries bare layer names and prefixes them from the config.
      const layerName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
      return [{ layerName, ...(title && title !== layerName ? { alias: title } : {}) }];
    });
    if (layers.length === 0) throw new Error('WFS capabilities listed no feature types');
    return { layers };
  }

  public async getLayer(layerName: string, signal?: AbortSignal): Promise<LayerDetail> {
    const doc = await fetchXml(
      this.url({
        service: 'WFS',
        version: '1.1.0',
        request: 'DescribeFeatureType',
        typeName: layerName,
      }),
      signal,
      credentialHeaders(this.credential)
    );
    // The schema's complexType holds a sequence of one element per property.
    const properties: LayerProperty[] = byLocalName(doc, 'sequence').flatMap((seq) =>
      byLocalName(seq, 'element').flatMap((el) => {
        const property = el.getAttribute('name');
        const type = el.getAttribute('type');
        if (!property || !type) return [];
        // servers write "xs:" or "xsd:" as they please; the app tests for "xsd:"
        return [{ property, type: type.replace(/^xs:/, 'xsd:') }];
      })
    );
    if (properties.length === 0) {
      throw new Error(`DescribeFeatureType returned no properties for "${layerName}"`);
    }
    return { layerName, properties };
  }
}

/**
 * Tries the layers API first and falls back to the WFS when it fails. The
 * fallback is decided per call, so a metadata service that comes back mid-
 * session is picked up again; `onFallback` fires on each failover so the UI
 * can say where its metadata is coming from.
 */
export class FallbackLayersApi implements LayersApiLike {
  public constructor(
    private readonly primary: LayersApiLike,
    private readonly fallback: LayersApiLike,
    private readonly onFallback: (error: string) => void
  ) {}

  public async listLayers(signal?: AbortSignal): Promise<LayersResponse> {
    return this.attempt(async (api) => api.listLayers(signal), signal);
  }

  public async getLayer(layerName: string, signal?: AbortSignal): Promise<LayerDetail> {
    return this.attempt(async (api) => api.getLayer(layerName, signal), signal);
  }

  private async attempt<T>(run: (api: LayersApiLike) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await run(this.primary);
    } catch (e) {
      // a cancelled request is not a failed one — don't mask it as a failover
      if (signal?.aborted) throw e;
      this.onFallback(e instanceof Error ? e.message : String(e));
      return run(this.fallback);
    }
  }
}
