import { credentialHeaders } from '../config';
import type { LayerDetail, LayersResponse } from './types';

export interface LayersApiLike {
  listLayers: (signal?: AbortSignal) => Promise<LayersResponse>;
  getLayer: (layerName: string, signal?: AbortSignal) => Promise<LayerDetail>;
}

/**
 * `baseUrl` is the layer-list endpoint itself — the list is GET {baseUrl},
 * a layer's detail GET {baseUrl}/{name}. Any path the API wants ("/layers",
 * "/api/v2/metadata", …) is part of the configured URL, not hardcoded here.
 */
export class LayersApi implements LayersApiLike {
  public constructor(
    private readonly baseUrl: string,
    private readonly credential?: { apiKey?: string; apiKeyHeader?: string }
  ) {}

  private url(path = ''): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  public async listLayers(signal?: AbortSignal): Promise<LayersResponse> {
    const res = await fetch(this.url(), {
      signal,
      headers: credentialHeaders(this.credential),
    });
    if (!res.ok) throw new Error(`GET ${this.url()} failed (HTTP ${res.status})`);
    return (await res.json()) as LayersResponse;
  }

  public async getLayer(layerName: string, signal?: AbortSignal): Promise<LayerDetail> {
    const res = await fetch(this.url(`/${encodeURIComponent(layerName)}`), {
      signal,
      headers: credentialHeaders(this.credential),
    });
    if (!res.ok) {
      throw new Error(`GET ${this.url(`/${layerName}`)} failed (HTTP ${res.status})`);
    }
    return (await res.json()) as LayerDetail;
  }
}
