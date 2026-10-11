import { useEffect, useRef, useState } from "react";
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
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import { transform } from "ol/proj";
import { credentialHeaders, type AppConfig } from "../config";
import { wmtsDescriptor } from "./wmts";

interface Props {
  features: Feature<Geometry>[];
  selectedFeature: Feature<Geometry> | null;
  srsName: string;
  config: AppConfig;
}

const HEIGHT_KEYS = ["relative_feature_height", "height", "building_height"];
const FILL = Color.fromCssColorString("#5cc8ff").withAlpha(0.55);
const FILL_SELECTED = Color.fromCssColorString("#ffd166").withAlpha(0.8);
const LINE = Color.fromCssColorString("#5cc8ff");
const LINE_SELECTED = Color.fromCssColorString("#ffd166");

function rings(input: unknown): number[][][] {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (typeof input[0] === "number") return [];
  if (typeof (input[0] as unknown[])[0] === "number") return [input as number[][]];
  return (input as unknown[]).flatMap(rings);
}

function threeD(feature: Feature<Geometry>) {
  for (const [property, value] of Object.entries(feature.getProperties())) {
    const g = value as { getCoordinates?: () => unknown; getType?: () => string } | null;
    if (!g || typeof g.getCoordinates !== "function") continue;
    const coords = g.getCoordinates();
    const flat = rings(coords);
    const probe = flat.length > 0 ? flat[0][0] : Array.isArray(coords) && typeof (coords as number[])[0] === "number" ? (coords as number[]) : null;
    if (!probe || probe.length < 3 || !Number.isFinite(probe[2])) continue;
    return { property, coords, type: typeof g.getType === "function" ? g.getType() : "" };
  }
  return null;
}

function heightOf(feature: Feature<Geometry>): number {
  const props = feature.getProperties();
  for (const key of HEIGHT_KEYS) {
    const raw = props[key];
    const n = typeof raw === "string" ? Number(raw) : (raw as number);
    if (Number.isFinite(n) && n > 0) return n as number;
  }
  return 0;
}


async function baseImagery(
  config: AppConfig,
  report: (line: string) => void
): Promise<ImageryLayer | null> {
  const cfg = config.wmts;
  if (cfg.capabilitiesUrl) {
    const d = await wmtsDescriptor(cfg, cfg.capabilitiesUrl, cfg.layer);
    if (!d) {
      throw new Error(
        `capabilities at ${cfg.capabilitiesUrl} gave no usable tile URL for layer "${cfg.layer}"` +
          `${cfg.matrixSet ? ` in matrix set "${cfg.matrixSet}"` : ""}` +
          `${cfg.format ? ` with format "${cfg.format}"` : ""}`
      );
    }
    {
      const geographic = /4326|CRS84/i.test(d.matrixSet);
      const headers = credentialHeaders(cfg);
      report(
        `WMTS ${cfg.layer} · ${d.matrixSet} · ${geographic ? "geographic" : "web mercator"} · levels ${d.labels[0]}..${d.labels[d.labels.length - 1]}`
      );
      const provider = new WebMapTileServiceImageryProvider({
          url: new Resource({ url: d.template, headers }),
          layer: cfg.layer,
          style: cfg.style || "default",
          format: d.format,
          tileMatrixSetID: d.matrixSet,
          tileMatrixLabels: d.labels,
          maximumLevel: d.labels.length - 1,
          tilingScheme: geographic
            ? new GeographicTilingScheme()
            : new WebMercatorTilingScheme()
      });
      let reported = 0;
      provider.errorEvent.addEventListener((err: { message?: string; error?: unknown }) => {
        reported += 1;
        if (reported <= 3) {
          const detail = err?.message ?? String(err?.error ?? "unknown");
          report(`tile error: ${detail}`);
          console.error("[Map3DView] tile request failed", err);
        }
      });
      return new ImageryLayer(provider);
    }
  }
  if (cfg.osmFallback) {
    report("OpenStreetMap fallback");
    return new ImageryLayer(new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }));
  }
  report("no base imagery configured — set wmts.capabilitiesUrl or wmts.osmFallback");
  return null;
}

export default function Map3DView({ features, selectedFeature, srsName, config }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewer = useRef<Viewer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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
        selectionIndicator: false
      });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    v.scene.globe.baseColor = Color.fromCssColorString("#0d1b24");
    v.scene.globe.showGroundAtmosphere = false;
    viewer.current = v;

    let cancelled = false;
    const report = (line: string) => {
      if (cancelled) return;
      console.info("[Map3DView]", line);
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
        console.error("[Map3DView] base imagery failed:", e);
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

    const toLonLat = (c: number[]): number[] =>
      srsName === "EPSG:4326" ? c : [...transform([c[0], c[1]], srsName, "EPSG:4326"), c[2]];

    let drew = 0;
    for (const feature of features) {
      const found = threeD(feature);
      if (!found) continue;
      const isSelected = feature === selectedFeature;
      const polys = rings(found.coords);
      const extra = heightOf(feature);

      if (polys.length === 0) {
        const c = toLonLat(found.coords as number[]);
        v.entities.add({
          position: Cartesian3.fromDegrees(c[0], c[1], c[2]),
          point: {
            pixelSize: isSelected ? 14 : 9,
            color: isSelected ? LINE_SELECTED : LINE,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            heightReference: HeightReference.NONE
          }
        });
        drew += 1;
        continue;
      }

      const closed = found.type.includes("Polygon");
      for (const ring of polys) {
        const lonlat = ring.map(toLonLat);
        const positions = lonlat.map((c) => Cartesian3.fromDegrees(c[0], c[1], c[2]));
        if (closed) {
          const floor = Math.min(...lonlat.map((c) => c[2])) - (extra || 0);
          v.entities.add({
            polygon: {
              hierarchy: new PolygonHierarchy(positions),
              perPositionHeight: true,
              extrudedHeight: extra > 0 ? floor : undefined,
              material: isSelected ? FILL_SELECTED : FILL,
              outline: true,
              outlineColor: isSelected ? LINE_SELECTED : LINE
            }
          });
        } else {
          v.entities.add({
            polyline: {
              positions,
              width: isSelected ? 6 : 3,
              material: isSelected ? LINE_SELECTED : LINE,
              arcType: ArcType.NONE
            }
          });
        }
        drew += 1;
      }
    }

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
    </div>
  );
}
