import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import type Map from "ol/Map";
import type { Extent } from "ol/extent";
import { loadConfig, type AppConfig, type WfsConfig } from "./config";
import { LayersApi, type LayersApiLike } from "./api/client";
import { FallbackLayersApi, WfsMetaApi } from "./api/wfsMeta";
import type { LayerProperty } from "./api/types";
import MapView, { type BaseMapSpec, type DrawMode } from "./map/MapView";
import Map3DView from "./map/Map3DView";
import { fetchCswRecords, type CswRecord } from "./api/csw";
import QueryPanel from "./query/QueryPanel";
import ResultsTable from "./components/ResultsTable";
import HistoryTimeline from "./history/HistoryTimeline";
import FeatureDiff, { type DiffSlot } from "./history/FeatureDiff";
import ExchangeViewer from "./components/ExchangeViewer";
import ElevationProfile from "./components/ElevationProfile";
import Feature3D from "./components/Feature3D";
import {
  QueryError,
  buildGetFeatureXml,
  executeQuery,
  withShape,
  type QuerySpec,
  type SpatialFilter,
} from "./query/wfs";

/** How many catalog products may be stacked on the map at once. */
const MAX_BASE_MAPS = 3;

export default function App() {
  // Injected into the page before the bundle runs, so it is there from the start
  const config = useMemo<AppConfig>(() => loadConfig(), []);

  const [features, setFeatures] = useState<Feature<Geometry>[]>([]);
  const [resultProps, setResultProps] = useState<LayerProperty[]>([]);
  const [selected, setSelected] = useState<Feature<Geometry> | null>(null);
  /** Layer of the last run, so history knows which versioned type to read. */
  const [queriedLayer, setQueriedLayer] = useState<string | null>(null);
  /** A past version picked from the timeline, drawn over the results. */
  const [versionFeature, setVersionFeature] = useState<Feature<Geometry> | null>(null);
  const [diffA, setDiffA] = useState<Feature<Geometry> | null>(null);
  const [diffB, setDiffB] = useState<Feature<Geometry> | null>(null);
  const [running, setRunning] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [spatial, setSpatial] = useState<SpatialFilter | null>(null);
  const [drawing, setDrawing] = useState<DrawMode | null>(null);
  const mapRef = useRef<Map | null>(null);
  const [threeD, setThreeD] = useState(false);

  const [requestXml, setRequestXml] = useState<string | null>(null);
  const [responseXml, setResponseXml] = useState<string | null>(null);

  // Which of the configured GeoServers to query; an empty list means the base
  // `wfs` config is the only one and there is nothing to pick.
  const servers = config.wfs.servers ?? [];
  const [serverIndex, setServerIndex] = useState(0);
  const activeServer =
    servers.length > 0 ? servers[Math.min(serverIndex, servers.length - 1)] : null;

  // The version is the one WFS setting worth switching at runtime — servers
  // differ in what they speak, and comparing answers is part of debugging.
  const [wfsVersion, setWfsVersion] = useState(
    servers[0]?.version ?? config.wfs.version ?? "1.1.0",
  );
  const wfs = useMemo<WfsConfig>(() => {
    const overrides = activeServer
      ? {
          url: activeServer.url,
          ...(activeServer.srsName ? { srsName: activeServer.srsName } : {}),
          ...(activeServer.featureNS ? { featureNS: activeServer.featureNS } : {}),
          ...(activeServer.featurePrefix
            ? { featurePrefix: activeServer.featurePrefix }
            : {}),
          ...(activeServer.geometryName
            ? { geometryName: activeServer.geometryName }
            : {}),
          ...(activeServer.apiKey ? { apiKey: activeServer.apiKey } : {}),
          ...(activeServer.apiKeyHeader
            ? { apiKeyHeader: activeServer.apiKeyHeader }
            : {}),
        }
      : {};
    return { ...config.wfs, ...overrides, version: wfsVersion };
  }, [config, activeServer, wfsVersion]);

  /** Switching servers re-arms that server's own dialect and metadata source. */
  function selectServer(index: number) {
    setServerIndex(index);
    setWfsVersion(servers[index]?.version ?? config.wfs.version ?? "1.1.0");
    setMetaNotice(null);
  }

  // Raster products from the CSW catalog, when one is configured
  const [records, setRecords] = useState<CswRecord[]>([]);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  useEffect(() => {
    const cswUrl = config.wmts.cswUrl;
    if (!cswUrl) return;
    const ctrl = new AbortController();
    fetchCswRecords(cswUrl, ctrl.signal)
      .then(setRecords)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted)
          setRecordsError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [config]);

  // The deployment names which products back the map (`wmts.productIds`,
  // bottom first); with none configured the catalog's first stands in. Stacking
  // works because rasters over transparent tiles show through to those below.
  const { baseMaps, missingIds } = useMemo(() => {
    const empty = { baseMaps: [] as BaseMapSpec[], missingIds: [] as string[] };
    if (records.length === 0) return empty;
    const ids = (config.wmts.productIds ?? [])
      .filter(Boolean)
      .slice(0, MAX_BASE_MAPS);
    const chosen =
      ids.length > 0
        ? ids
            .map((id) => records.find((r) => r.id === id))
            .filter((r): r is CswRecord => !!r)
        : [records[0]];
    return {
      baseMaps: chosen.map((r) => ({
        capabilitiesUrl: r.capabilitiesUrl,
        layerId: r.layerId,
      })),
      missingIds: ids.filter((id) => !records.some((r) => r.id === id)),
    };
  }, [records, config]);

  useEffect(() => {
    document.title = config.ui.title;
  }, [config]);

  // Layer metadata for the active server: its own API when it names one (the
  // base `api.baseUrl` for the base config), the WFS itself otherwise — and
  // the WFS again, as a fallback, when the API turns out to be unreachable.
  const [metaNotice, setMetaNotice] = useState<string | null>(null);
  const layersApi = useMemo<LayersApiLike>(() => {
    const meta = new WfsMetaApi(wfs.url, wfs);
    const apiBaseUrl = activeServer ? activeServer.apiBaseUrl : config.api.baseUrl;
    if (!apiBaseUrl) return meta;
    return new FallbackLayersApi(new LayersApi(apiBaseUrl, config.api), meta, (error) =>
      setMetaNotice(
        `Layers API unavailable (${error}) — reading layer metadata from the WFS itself`,
      ),
    );
  }, [config, activeServer, wfs.url]);
  const capturingApi = useMemo<LayersApiLike>(
    () =>
      new PropCapturingApi(layersApi, (props) => (lastDetailProps.current = props)),
    [layersApi],
  );

  /** `xmlOverride` is a hand-edited request; it is POSTed instead of the generated one. */
  async function runQuery(spec: QuerySpec, xmlOverride?: string) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setQueryError(null);
    setSelected(null);
    setVersionFeature(null);
    setDiffA(null);
    setDiffB(null);
    setQueriedLayer(spec.layerName);
    try {
      const body = xmlOverride ?? buildGetFeatureXml(wfs, spec);
      setRequestXml(body);
      setResponseXml(null);
      const result = await executeQuery(wfs, body, ctrl.signal);
      setResponseXml(result.responseXml);
      setFeatures(result.features);
      setResultProps(
        spec.property
          ? [spec.property, ...resultPropsFor(spec)]
          : resultPropsFor(spec),
      );
      if (result.features.length === 0)
        setQueryError("No features matched the filter");
    } catch (e: unknown) {
      if (!ctrl.signal.aborted) {
        setFeatures([]);
        if (e instanceof QueryError) setResponseXml(e.responseXml);
        setQueryError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!ctrl.signal.aborted) setRunning(false);
    }
  }

  // The panel knows the full property list; keep the queried property first
  // and let ResultsTable pick informative columns from whatever came back.
  const lastDetailProps = useRef<LayerProperty[]>([]);
  function resultPropsFor(spec: QuerySpec): LayerProperty[] {
    return lastDetailProps.current.filter(
      (p) => p.property !== spec.property?.property,
    );
  }

  function clearAll() {
    abortRef.current?.abort();
    setFeatures([]);
    setSelected(null);
    setVersionFeature(null);
    setDiffA(null);
    setDiffB(null);
    setQueriedLayer(null);
    setQueryError(null);
    setRunning(false);
    setSpatial(null);
    setDrawing(null);
    setRequestXml(null);
    setResponseXml(null);
  }

  const handleMapReady = useCallback((m: Map) => {
    mapRef.current = m;
  }, []);

  const handleBboxDrawn = useCallback((extent: Extent) => {
    setSpatial((cur) => withShape(cur, { kind: "bbox", extent }));
    setDrawing(null);
  }, []);

  const handlePolygonDrawn = useCallback((geometry: Geometry) => {
    setSpatial((cur) => withShape(cur, { kind: "geometry", geometry }));
    setDrawing(null);
  }, []);

  /** A vertex was dragged on the map — the edited shape replaces the old one. */
  const handleGeometryEdited = useCallback((geometry: Geometry) => {
    setSpatial((cur) => withShape(cur, { kind: "geometry", geometry }));
  }, []);

  const cancelDraw = useCallback(() => setDrawing(null), []);

  /** Clicking the selected row again deselects it. */
  const toggleSelected = useCallback((f: Feature<Geometry> | null) => {
    setSelected((cur) => (cur === f ? null : f));
  }, []);

  /**
   * On the map, a click always selects what it hit — toggling there would mean
   * that once the view has flown to a feature filling the screen, the next
   * click could only ever deselect it. Empty map still clears.
   */
  const selectFromMap = useCallback(
    (f: Feature<Geometry> | null) => setSelected(f),
    [],
  );

  /** Snap the bbox to whatever the map is currently showing. */
  function useViewExtent() {
    const map = mapRef.current;
    const size = map?.getSize();
    if (!map || !size) return;
    setDrawing(null);
    setSpatial((cur) =>
      withShape(cur, {
        kind: "bbox",
        extent: map.getView().calculateExtent(size),
      }),
    );
  }

  return (
    <div className="app" dir={config.ui.direction}>
      {config.threeD?.enabled && threeD && (
        <Map3DView
          features={versionFeature ? [...features, versionFeature] : features}
          selectedFeature={versionFeature ?? selected}
          srsName={wfs.srsName}
          config={config}
        />
      )}
      {config.threeD?.enabled && (
        <button
          type="button"
          className="map3d-toggle"
          onClick={() => setThreeD((v) => !v)}
          title={threeD ? "Show the 2D map" : "Show 3D geometry"}
        >
          {threeD ? "2D" : "3D"}
        </button>
      )}
      <MapView
        config={config}
        features={versionFeature ? [...features, versionFeature] : features}
        selectedFeature={versionFeature ?? selected}
        spatial={spatial}
        drawing={drawing}
        baseMaps={baseMaps}
        onBboxDrawn={handleBboxDrawn}
        onPolygonDrawn={handlePolygonDrawn}
        onGeometryEdited={handleGeometryEdited}
        onCancelDraw={cancelDraw}
        onMapReady={handleMapReady}
        onSelectFeature={selectFromMap}
        onBaseLayerError={(m) => setNotice(`Base layer failed to load: ${m}`)}
      />
      {config.ui.disclaimer && (
        <div className="map-disclaimer" dir={config.ui.direction}>
          {config.ui.disclaimer}
        </div>
      )}
      <aside className="panel">
        <div className="panel-scroll">
          <header className="panel-header">
            <h1>{config.ui.title}</h1>
          </header>
          <QueryPanel
            api={capturingApi}
            wfs={wfs}
            servers={servers}
            serverIndex={serverIndex}
            onServerChange={selectServer}
            running={running}
            spatial={spatial}
            drawing={drawing}
            onDraw={(mode) => setDrawing((d) => (d === mode ? null : mode))}
            onUseViewExtent={useViewExtent}
            onSpatialChange={(s) => {
              setSpatial(s);
              setDrawing(null);
            }}
            onVersionChange={setWfsVersion}
            onRun={runQuery}
            onClear={clearAll}
          />
          {recordsError && (
            <div className="notice">Catalog: {recordsError}</div>
          )}
          {missingIds.length > 0 && (
            <div className="notice">
              Configured base maps not in the catalog: {missingIds.join(", ")}
            </div>
          )}
          {metaNotice && <div className="notice">{metaNotice}</div>}
          {notice && <div className="notice">{notice}</div>}
          {queryError && (
            <div className="notice notice-error">{queryError}</div>
          )}
          <ResultsTable
            features={features}
            properties={resultProps}
            selected={selected}
            featureProjection={wfs.srsName}
            onSelect={toggleSelected}
          />
          {config.threeD?.enabled && (
            <>
              <Feature3D feature={versionFeature ?? selected} />
              <ElevationProfile feature={versionFeature ?? selected} />
            </>
          )}
          {config.history?.enabled && queriedLayer && (
            <HistoryTimeline
              wfs={wfs}
              history={config.history}
              layerName={queriedLayer}
              feature={selected}
              properties={resultProps}
              onShowVersion={setVersionFeature}
            />
          )}
          {config.history?.enabled && queriedLayer && (
            <FeatureDiff
              a={diffA}
              b={diffB}
              selected={versionFeature ?? selected}
              properties={resultProps}
              featureProjection={wfs.srsName}
              onPin={(slot: DiffSlot, feature) =>
                slot === "a" ? setDiffA(feature) : setDiffB(feature)
              }
            />
          )}
          <ExchangeViewer
            requestXml={requestXml}
            responseXml={responseXml}
            features={features}
            featureProjection={wfs.srsName}
          />
        </div>
      </aside>
    </div>
  );
}

/** Thin wrapper so App can remember the last-loaded layer's properties. */
class PropCapturingApi implements LayersApiLike {
  constructor(
    private readonly inner: LayersApiLike,
    private readonly onProps: (props: LayerProperty[]) => void,
  ) {}
  listLayers(signal?: AbortSignal) {
    return this.inner.listLayers(signal);
  }
  async getLayer(layerName: string, signal?: AbortSignal) {
    const d = await this.inner.getLayer(layerName, signal);
    this.onProps(d.properties);
    return d;
  }
}
