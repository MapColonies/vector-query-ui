import { useEffect, useRef, useState } from 'react';
import {
  Cartesian3,
  Color,
  PolygonHierarchy,
  Viewer,
  ArcType,
  HeightReference,
  ImageryLayer,
  OpenStreetMapImageryProvider,
  WebMapTileServiceImageryProvider,
  Resource,
  GeographicTilingScheme,
  WebMercatorTilingScheme,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type Feature from 'ol/Feature';
import { transform } from 'ol/proj';
import { credentialHeaders, type AppConfig } from '../config';
import { wmtsDescriptor } from './wmts';

interface Props {
  features: Feature[];
  selectedFeature: Feature | null;
  srsName: string;
  config: AppConfig;
}

const COORDINATES = 'coordinates';
const FILL = Color.fromCssColorString('#5cc8ff').withAlpha(0.55);
const FILL_SELECTED = Color.fromCssColorString('#ffd166').withAlpha(0.8);
const LINE = Color.fromCssColorString('#5cc8ff');
const LINE_SELECTED = Color.fromCssColorString('#ffd166');

function rings(input: unknown): number[][][] {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (typeof input[0] === 'number') return [];
  if (typeof (input[0] as unknown[])[0] === 'number') return [input as number[][]];
  return (input as unknown[]).flatMap(rings);
}

function threeD(feature: Feature) {
  for (const [property, value] of Object.entries(feature.getProperties())) {
    const g = value as { getCoordinates?: () => unknown; getType?: () => string } | null;
    if (!g || typeof g.getCoordinates !== 'function') continue;
    const coords = g.getCoordinates();
    const flat = rings(coords);
    const probe = flat.length > 0 ? flat[0][0] : Array.isArray(coords) && typeof (coords as number[])[0] === 'number' ? (coords as number[]) : null;
    if (!probe || probe.length < 3 || !Number.isFinite(probe[2])) continue;
    return { property, coords, type: typeof g.getType === 'function' ? g.getType() : '' };
  }
  return null;
}

/** What one feature's extrusion was computed from, shown in the 3D view for debugging. */
interface ExtrusionInfo {
  id: string;
  from: string;
  to: string;
  fromValue: unknown;
  toValue: unknown;
  zRange: [number, number];
  base: number | null;
  drawn: [number, number | null];
}

const fmt = (n: number | null): string => (n === null ? '—' : String(Math.round(n * 1000) / 1000));
const raw = (v: unknown): string => (v === undefined ? 'missing' : JSON.stringify(v));

function fieldHeight(feature: Feature, field: string): number | null {
  if (field === '' || field === COORDINATES) return null;
  const raw: unknown = feature.get(field);
  const n = typeof raw === 'string' ? Number(raw) : (raw as number);
  return Number.isFinite(n) ? n : null;
}

async function baseImagery(config: AppConfig, report: (line: string) => void): Promise<ImageryLayer | null> {
  const cfg = config.wmts;
  if (cfg.capabilitiesUrl) {
    const d = await wmtsDescriptor(cfg, cfg.capabilitiesUrl, cfg.layer);
    if (!d) {
      throw new Error(
        `capabilities at ${cfg.capabilitiesUrl} gave no usable tile URL for layer "${cfg.layer}"` +
          `${cfg.matrixSet ? ` in matrix set "${cfg.matrixSet}"` : ''}` +
          `${cfg.format ? ` with format "${cfg.format}"` : ''}`
      );
    }
    {
      const geographic = /4326|CRS84/i.test(d.matrixSet);
      const headers = credentialHeaders(cfg);
      report(
        `WMTS ${cfg.layer} · ${d.matrixSet} · ${geographic ? 'geographic' : 'web mercator'} · levels ${d.labels[0]}..${d.labels[d.labels.length - 1]}`
      );
      const provider = new WebMapTileServiceImageryProvider({
        url: new Resource({ url: d.template, headers }),
        layer: cfg.layer,
        style: cfg.style || 'default',
        format: d.format,
        tileMatrixSetID: d.matrixSet,
        tileMatrixLabels: d.labels,
        maximumLevel: d.labels.length - 1,
        tilingScheme: geographic ? new GeographicTilingScheme() : new WebMercatorTilingScheme(),
      });
      let reported = 0;
      provider.errorEvent.addEventListener((err: { message?: string; error?: unknown } | undefined) => {
        reported += 1;
        if (reported <= 3) {
          const detail = err?.message ?? String(err?.error ?? 'unknown');
          report(`tile error: ${detail}`);
          console.error('[Map3DView] tile request failed', err);
        }
      });
      return new ImageryLayer(provider);
    }
  }
  if (cfg.osmFallback) {
    report('OpenStreetMap fallback');
    return new ImageryLayer(new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }));
  }
  report('no base imagery configured — set wmts.capabilitiesUrl or wmts.osmFallback');
  return null;
}

export default function Map3DView({ features, selectedFeature, srsName, config }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewer = useRef<Viewer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [extrusion, setExtrusion] = useState<ExtrusionInfo | null>(null);

  useEffect(() => {
    if (!host.current || viewer.current) return;
    let v: Viewer;
    try {
      v = new Viewer(host.current, {
        baseLayer: false,
        animation: false,
        timeline: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        baseLayerPicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
      });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    v.scene.globe.baseColor = Color.fromCssColorString('#0d1b24');
    v.scene.globe.showGroundAtmosphere = false;
    viewer.current = v;

    let cancelled = false;
    const report = (line: string) => {
      if (cancelled) return;
      console.info('[Map3DView]', line);
      setStatus(line);
    };
    void baseImagery(config, report)
      .then((layer) => {
        if (!cancelled && layer && !v.isDestroyed()) {
          v.imageryLayers.add(layer);
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Map3DView] base imagery failed:', e);
        report(`imagery failed — ${msg}`);
      });
    return () => {
      cancelled = true;
      v.destroy();
      viewer.current = null;
    };
  }, [config]);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.entities.removeAll();

    const toLonLat = (c: number[]): number[] => (srsName === 'EPSG:4326' ? c : [...transform([c[0], c[1]], srsName, 'EPSG:4326'), c[2]]);
    const extrude = { from: config.threeD?.extrude?.from ?? '', to: config.threeD?.extrude?.to ?? COORDINATES };

    let drew = 0;
    let shown: ExtrusionInfo | null = null;
    for (const feature of features) {
      const found = threeD(feature);
      if (!found) continue;
      const isSelected = feature === selectedFeature;
      const polys = rings(found.coords);
      const top = fieldHeight(feature, extrude.to);
      const bottom = fieldHeight(feature, extrude.from);
      const bottomIsZ = extrude.from === COORDINATES;
      const allZs = polys.length === 0 ? [(found.coords as number[])[2]] : polys.flat().map((c) => c[2]);
      const base = bottomIsZ ? Math.min(...allZs) : bottom;
      const lift = (c: number[]): number[] => [c[0], c[1], (bottomIsZ || top === null ? c[2] : top) - (base ?? 0)];

      const lifted = allZs.map((z) => (bottomIsZ || top === null ? z : top) - (base ?? 0));
      const extrudedTo =
        polys.length === 0 || !found.type.includes('Polygon')
          ? null
          : bottomIsZ
            ? top === null
              ? null
              : top - (base ?? 0)
            : base === null
              ? null
              : 0;
      const info: ExtrusionInfo = {
        id: String(feature.getId() ?? '(no id)'),
        from: extrude.from,
        to: extrude.to,
        fromValue: extrude.from === COORDINATES ? 'geometry Z' : extrude.from === '' ? '(not set)' : feature.get(extrude.from),
        toValue: extrude.to === COORDINATES ? 'geometry Z' : extrude.to === '' ? '(not set)' : feature.get(extrude.to),
        zRange: [Math.min(...allZs), Math.max(...allZs)],
        base,
        drawn: [Math.min(...lifted), extrudedTo],
      };
      console.debug('[Map3DView] extrusion', info);
      if (isSelected || shown === null) shown = info;

      if (polys.length === 0) {
        const c = lift(toLonLat(found.coords as number[]));
        v.entities.add({
          position: Cartesian3.fromDegrees(c[0], c[1], c[2]),
          point: {
            pixelSize: isSelected ? 14 : 9,
            color: isSelected ? LINE_SELECTED : LINE,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            heightReference: HeightReference.NONE,
          },
        });
        drew += 1;
        continue;
      }

      const closed = found.type.includes('Polygon');
      for (const ring of polys) {
        const lonlat = ring.map((c) => lift(toLonLat(c)));
        const positions = lonlat.map((c) => Cartesian3.fromDegrees(c[0], c[1], c[2]));
        if (closed) {
          const other = bottomIsZ ? (top === null ? null : top - (base ?? 0)) : base === null ? null : 0;
          v.entities.add({
            polygon: {
              hierarchy: new PolygonHierarchy(positions),
              perPositionHeight: true,
              extrudedHeight: other ?? undefined,
              material: isSelected ? FILL_SELECTED : FILL,
              outline: true,
              outlineColor: isSelected ? LINE_SELECTED : LINE,
            },
          });
        } else {
          v.entities.add({
            polyline: {
              positions,
              width: isSelected ? 6 : 3,
              material: isSelected ? LINE_SELECTED : LINE,
              arcType: ArcType.NONE,
            },
          });
        }
        drew += 1;
      }
    }

    setExtrusion(shown);
    if (drew > 0) {
      v.zoomTo(v.entities).catch(() => undefined);
    }
  }, [features, selectedFeature, srsName]);

  if (failure) {
    return (
      <div className="map3d map3d-failed">
        <p>3D view unavailable — {failure}</p>
      </div>
    );
  }

  return (
    <div className="map3d" ref={host}>
      {status && <div className="map3d-status">{status}</div>}
      {extrusion && (
        <div className="map3d-extrusion">
          <div>feature {extrusion.id}</div>
          <div>
            from <b>{extrusion.from || '(not set)'}</b> = {raw(extrusion.fromValue)}
          </div>
          <div>
            to <b>{extrusion.to}</b> = {raw(extrusion.toValue)}
          </div>
          <div>
            geometry Z {fmt(extrusion.zRange[0])} … {fmt(extrusion.zRange[1])}
          </div>
          <div>base subtracted {fmt(extrusion.base)}</div>
          <div>
            drawn at {fmt(extrusion.drawn[0])} m, extruded to {fmt(extrusion.drawn[1])} m
          </div>
        </div>
      )}
    </div>
  );
}
