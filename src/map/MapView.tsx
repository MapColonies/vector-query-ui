import { useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import type { Pixel } from "ol/pixel";
import Draw, { createBox } from "ol/interaction/Draw";
import Modify from "ol/interaction/Modify";
import DragPan from "ol/interaction/DragPan";
import { always } from "ol/events/condition";
import { Fill, Stroke, Style, Circle as CircleStyle } from "ol/style";
import { isEmpty, type Extent } from "ol/extent";
import proj4 from "proj4";
import { register } from "ol/proj/proj4";
import "ol/ol.css";
import type { AppConfig } from "../config";
import { spatialGeometry, type SpatialFilter } from "../query/wfs";
import type TileLayer from "ol/layer/Tile";
import { createBaseLayer, createWmtsLayer } from "./wmts";

/** A catalog product resolved to what a WMTS layer is built from. */
export interface BaseMapSpec {
  capabilitiesUrl: string;
  layerId: string;
}

const ACCENT = "#5cc8ff";
const ACCENT_SELECTED = "#ffd166";

const HALO = "rgba(8, 20, 28, 0.65)";

/** Dark halo under a bright outline — results stay legible over any imagery. */
const resultStyle = [
  new Style({ stroke: new Stroke({ color: HALO, width: 6 }) }),
  new Style({
    stroke: new Stroke({ color: ACCENT, width: 2.5 }),
    fill: new Fill({ color: "rgba(92, 200, 255, 0.28)" }),
    image: new CircleStyle({
      radius: 7,
      fill: new Fill({ color: "rgba(92, 200, 255, 0.75)" }),
      stroke: new Stroke({ color: "#ffffff", width: 2 })
    })
  })
];

const selectedStyle = [
  new Style({ stroke: new Stroke({ color: HALO, width: 9 }) }),
  new Style({
    stroke: new Stroke({ color: "#ffffff", width: 5 }),
    fill: new Fill({ color: "rgba(255, 209, 102, 0.4)" })
  }),
  new Style({
    stroke: new Stroke({ color: ACCENT_SELECTED, width: 2.5 }),
    image: new CircleStyle({
      radius: 10,
      fill: new Fill({ color: "rgba(255, 209, 102, 0.9)" }),
      stroke: new Stroke({ color: "#ffffff", width: 3 })
    })
  })
];

/** Dark halo underneath a bright dashed outline, so the box reads over any base map. */
const bboxStyle = [
  new Style({ stroke: new Stroke({ color: "rgba(8, 20, 28, 0.6)", width: 7 }) }),
  new Style({
    stroke: new Stroke({ color: ACCENT_SELECTED, width: 2.5, lineDash: [10, 6] }),
    fill: new Fill({ color: "rgba(255, 209, 102, 0.12)" }),
    image: new CircleStyle({
      radius: 4,
      fill: new Fill({ color: ACCENT_SELECTED }),
      stroke: new Stroke({ color: "rgba(8, 20, 28, 0.6)", width: 1.5 })
    })
  })
];

/** The rectangle being dragged out — solid, so it is clearly "in progress". */
const sketchStyle = [
  new Style({ stroke: new Stroke({ color: "rgba(8, 20, 28, 0.6)", width: 7 }) }),
  new Style({
    stroke: new Stroke({ color: ACCENT_SELECTED, width: 2.5 }),
    fill: new Fill({ color: "rgba(255, 209, 102, 0.2)" })
  })
];

/** Keeps fitted features clear of the console, which floats on the right. */
const FIT_PADDING = [60, 600, 60, 60];

/** A box is dragged out in one gesture; a polygon is clicked vertex by vertex. */
export type DrawMode = "bbox" | "polygon";

interface Props {
  config: AppConfig;
  features: Feature<Geometry>[];
  selectedFeature: Feature<Geometry> | null;
  /** Current spatial constraint, outlined on the map. */
  spatial: SpatialFilter | null;
  /** Which shape the next gesture on the map draws, if any. */
  drawing: DrawMode | null;
  onBboxDrawn: (extent: Extent) => void;
  /** A drawn polygon, in the view's projection. */
  onPolygonDrawn: (geometry: Geometry) => void;
  /** The spatial geometry after a vertex was moved, in the view's projection. */
  onGeometryEdited: (geometry: Geometry) => void;
  /** Escape while drawing. */
  onCancelDraw: () => void;
  /**
   * Catalog products stacked as the map's background, bottom first. Rasters
   * with transparency show through to the ones beneath them.
   */
  baseMaps: BaseMapSpec[];
  /** Handed the map once it exists, so the panel can read the current view. */
  onMapReady: (map: Map) => void;
  /** A click on a result, or null when the click landed on empty map. */
  onSelectFeature: (feature: Feature<Geometry> | null) => void;
  onBaseLayerError: (message: string) => void;
}

export default function MapView({
  config,
  features,
  selectedFeature,
  spatial,
  drawing,
  baseMaps,
  onBboxDrawn,
  onPolygonDrawn,
  onGeometryEdited,
  onCancelDraw,
  onMapReady,
  onSelectFeature,
  onBaseLayerError
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const sourceRef = useRef(new VectorSource<Feature<Geometry>>());
  const bboxSourceRef = useRef(new VectorSource<Feature<Geometry>>());
  const resultLayerRef = useRef<VectorLayer<VectorSource<Feature<Geometry>>> | null>(null);

  // Init once
  useEffect(() => {
    const custom = config.map.customProjections ?? {};
    for (const [code, def] of Object.entries(custom)) {
      proj4.defs(code, def);
    }
    if (Object.keys(custom).length > 0) register(proj4);

    const vectorLayer = new VectorLayer({
      source: sourceRef.current,
      style: (f) => (f === selectedRef.current ? selectedStyle : resultStyle)
    });
    resultLayerRef.current = vectorLayer;

    const bboxLayer = new VectorLayer({ source: bboxSourceRef.current, style: bboxStyle });

    const olMap = new Map({
      target: containerRef.current ?? undefined,
      layers: [vectorLayer, bboxLayer],
      view: new View({
        projection: config.map.projection,
        center: config.map.center,
        zoom: config.map.zoom
      })
    });

    // Skipped when a catalog product is coming — that effect owns layer 0
    if (!config.wmts.cswUrl) {
      createBaseLayer(config.wmts)
        .then((base) => base && olMap.getLayers().insertAt(0, base))
        .catch((err: unknown) =>
          onBaseLayerError(err instanceof Error ? err.message : String(err))
        );
    }

    setMap(olMap);
    onMapReady(olMap);
    return () => olMap.setTarget(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stack the configured catalog products under everything else, bottom first.
  // Each product has its own capabilities document, so a change means building
  // whole new sources; the old stack stays up until the new one is ready.
  const baseLayersRef = useRef<TileLayer[]>([]);
  useEffect(() => {
    if (!map || baseMaps.length === 0) return;
    let stale = false;
    Promise.allSettled(
      baseMaps.map((b) => createWmtsLayer(config.wmts, b.capabilitiesUrl, b.layerId))
    ).then((results) => {
      if (stale) return;
      for (const old of baseLayersRef.current) map.removeLayer(old);
      const added: TileLayer[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          // insert above the base maps already added, still below the vectors
          map.getLayers().insertAt(added.length, result.value);
          added.push(result.value);
        } else {
          const err: unknown = result.reason;
          onBaseLayerError(err instanceof Error ? err.message : String(err));
        }
      }
      baseLayersRef.current = added;
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, baseMaps]);

  // Mirror the spatial constraint onto the map
  useEffect(() => {
    const source = bboxSourceRef.current;
    source.clear();
    if (!spatial) return;
    source.addFeature(new Feature(spatialGeometry(spatial)));
  }, [spatial]);

  // Draw a new spatial filter. The sketch is not kept — only its geometry is.
  useEffect(() => {
    if (!map || !drawing) return;

    const draw = new Draw(
      drawing === "bbox"
        ? {
            // Freehand: press, drag, release. Without it Draw wants click-move-click
            // and the initial drag is swallowed by the pan interaction instead.
            type: "Circle",
            geometryFunction: createBox(),
            freehandCondition: always,
            style: sketchStyle
          }
        : { type: "Polygon", style: sketchStyle }
    );

    draw.on("drawend", (e) => {
      const geometry = e.feature.getGeometry();
      if (!geometry) return;
      if (drawing !== "bbox") {
        onPolygonDrawn(geometry);
        return;
      }
      const extent = geometry.getExtent();
      if (!isEmpty(extent)) onBboxDrawn(extent);
    });
    map.addInteraction(draw);

    // ...and belt-and-braces: no panning at all while a box is being dragged out.
    // A polygon is clicked vertex by vertex, so panning between them is welcome.
    const pans =
      drawing === "bbox"
        ? map
            .getInteractions()
            .getArray()
            .filter((i): i is DragPan => i instanceof DragPan)
        : [];
    for (const pan of pans) pan.setActive(false);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelDraw();
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      map.removeInteraction(draw);
      for (const pan of pans) pan.setActive(true);
    };
  }, [map, drawing, onBboxDrawn, onPolygonDrawn, onCancelDraw]);

  // A drawn or pasted geometry is always editable in place: hovering it shows
  // a vertex handle, dragging moves it. The outline feature is rebuilt on
  // every spatial change, but Modify tracks the source, so it always operates
  // on the current one. A bbox stays out — dragging its corner would quietly
  // turn "a box" into "a polygon" while the coordinate text still said box.
  const editable = spatial?.shape.kind === "geometry";
  useEffect(() => {
    if (!map || !editable || drawing) return;
    const modify = new Modify({ source: bboxSourceRef.current });
    modify.on("modifyend", (e) => {
      const geometry = e.features.item(0)?.getGeometry();
      // A clone, because Modify mutates in place — the panel tells a drawn
      // shape from its own parse by identity, and an edit must read as new.
      if (geometry) onGeometryEdited(geometry.clone());
    });
    map.addInteraction(modify);
    return () => {
      map.removeInteraction(modify);
    };
  }, [map, editable, drawing, onGeometryEdited]);

  /**
   * Click a result to select it; clicking bare map clears the selection. Off
   * while drawing, so the click that finishes a box is not read as a pick.
   */
  useEffect(() => {
    if (!map || drawing) return;

    const pick = (pixel: Pixel) =>
      map.forEachFeatureAtPixel(pixel, (f) => f as Feature<Geometry>, {
        layerFilter: (l) => l === resultLayerRef.current,
        hitTolerance: 5
      }) ?? null;

    const onClick = (e: MapBrowserEvent) => onSelectFeature(pick(e.pixel));

    // point the cursor at whatever is clickable
    const onMove = (e: MapBrowserEvent) => {
      if (e.dragging) return;
      const target = map.getTargetElement();
      if (target) target.style.cursor = pick(e.pixel) ? "pointer" : "";
    };

    map.on("singleclick", onClick);
    map.on("pointermove", onMove);
    return () => {
      map.un("singleclick", onClick);
      map.un("pointermove", onMove);
      const target = map.getTargetElement();
      if (target) target.style.cursor = "";
    };
  }, [map, drawing, onSelectFeature]);

  // Sync query results into the vector source and zoom to them
  useEffect(() => {
    const source = sourceRef.current;
    source.clear();
    if (features.length > 0) {
      source.addFeatures(features);
      const extent = source.getExtent();
      if (map && extent && !isEmpty(extent)) {
        map.getView().fit(extent, { padding: FIT_PADDING, maxZoom: 18, duration: 350 });
      }
    }
  }, [features, map]);

  // Highlight + fly to selected feature
  const selectedRef = useRef<Feature<Geometry> | null>(null);
  useEffect(() => {
    selectedRef.current = selectedFeature;
    sourceRef.current.changed();
    const geom = selectedFeature?.getGeometry();
    const extent = geom?.getExtent();
    if (map && extent && !isEmpty(extent)) {
      map.getView().fit(extent, { padding: FIT_PADDING, maxZoom: 19, duration: 350 });
    }
  }, [selectedFeature, map]);

  return <div ref={containerRef} className={`map-root${drawing ? " map-drawing" : ""}`} />;
}
