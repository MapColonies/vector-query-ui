import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type Geometry from 'ol/geom/Geometry';
import type { Extent } from 'ol/extent';
import type { LayersApiLike } from '../api/client';
import type { DrawMode } from '../map/MapView';
import { isGeometryProperty, layerLabel, propertyLabel, type LayerDetail, type LayerProperty, type LayerSummary } from '../api/types';
import type { WfsConfig, WfsServer } from '../config';
import { copyText } from '../clipboard';
import {
  DISTANCE_UNITS,
  SPATIAL_OPERATORS,
  isDateType,
  isNumericType,
  operatorsFor,
  spatialOperatorsFor,
  type OperatorId,
  type SpatialOperatorId,
} from './operators';
import {
  DEFAULT_DISTANCE,
  DEFAULT_GEOMETRY_NAME,
  DEFAULT_UNIT,
  buildGetFeatureXml,
  filterPreview,
  formatExtent,
  toCurlCommand,
  withShape,
  type QuerySpec,
  type SpatialFilter,
} from './wfs';
import { GEOJSON_DEFAULT_CRS, geometryToGeoJson, parseGeoJsonGeometry } from './geojson';

// Monaco is by far the heaviest thing in the app — split it out and fetch it
// the first time a code box is actually shown.
const CodeEditor = lazy(async () => import('../components/CodeEditor'));

/** Versions OpenLayers can write a GetFeature document for. */
const WFS_VERSIONS = ['1.0.0', '1.1.0', '2.0.0'];

interface Props {
  api: LayersApiLike;
  wfs: WfsConfig;
  /** Named GeoServers to offer; empty hides the picker. */
  servers: WfsServer[];
  serverIndex: number;
  onServerChange: (index: number) => void;
  running: boolean;
  /** Spatial constraint owned by App, so the map can render it. */
  spatial: SpatialFilter | null;
  drawing: DrawMode | null;
  onDraw: (mode: DrawMode) => void;
  onUseViewExtent: () => void;
  onSpatialChange: (spatial: SpatialFilter | null) => void;
  onVersionChange: (version: string) => void;
  onRun: (spec: QuerySpec, xmlOverride?: string) => void;
  onClear: () => void;
}

type SpatialMode = 'none' | 'bbox' | 'geojson';

export default function QueryPanel({
  api,
  wfs,
  servers,
  serverIndex,
  onServerChange,
  running,
  spatial,
  drawing,
  onDraw,
  onUseViewExtent,
  onSpatialChange,
  onVersionChange,
  onRun,
  onClear,
}: Props) {
  const [layers, setLayers] = useState<LayerSummary[]>([]);
  const [layersError, setLayersError] = useState<string | null>(null);

  const [selectedLayerName, setSelectedLayerName] = useState('');
  const [detail, setDetail] = useState<LayerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [selectedPropName, setSelectedPropName] = useState('');
  const [operator, setOperator] = useState<OperatorId>('eq');
  const [value, setValue] = useState('');
  const [maxFeatures, setMaxFeatures] = useState(wfs.maxFeatures ?? 200);

  const [spatialMode, setSpatialMode] = useState<SpatialMode>('none');
  const [bboxText, setBboxText] = useState('');
  const [geoJsonText, setGeoJsonText] = useState('');
  const [geoJsonCrs, setGeoJsonCrs] = useState(GEOJSON_DEFAULT_CRS);
  const [spatialError, setSpatialError] = useState<string | null>(null);

  /** null while the generated document is used as-is. */
  const [editedXml, setEditedXml] = useState<string | null>(null);
  const [showRequest, setShowRequest] = useState(false);

  // (Re)load the layer list whenever the metadata source changes — on mount,
  // and again when another GeoServer is picked. A stale selection would point
  // into the previous server's layers, so it goes too.
  useEffect(() => {
    const ctrl = new AbortController();
    setLayers([]);
    setSelectedLayerName('');
    setLayersError(null);
    api
      .listLayers(ctrl.signal)
      .then((r) => setLayers(r.layers))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setLayersError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [api]);

  // Load layer detail on selection
  useEffect(() => {
    setDetail(null);
    setSelectedPropName('');
    setValue('');
    setDetailError(null);
    if (!selectedLayerName) return;
    const ctrl = new AbortController();
    setDetailLoading(true);
    api
      .getLayer(selectedLayerName, ctrl.signal)
      .then((d) => setDetail(d))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setDetailLoading(false));
    return () => ctrl.abort();
  }, [api, selectedLayerName]);

  // Dropdowns sort by what the user reads — the label, not the raw name
  const sortedLayers = useMemo(() => [...layers].sort((a, b) => layerLabel(a).localeCompare(layerLabel(b))), [layers]);

  const queryableProps = useMemo(
    () => (detail?.properties ?? []).filter((p) => !isGeometryProperty(p)).sort((a, b) => propertyLabel(a).localeCompare(propertyLabel(b))),
    [detail]
  );

  const selectedProp: LayerProperty | undefined = useMemo(
    () => queryableProps.find((p) => p.property === selectedPropName),
    [queryableProps, selectedPropName]
  );

  // Reset operator/value when property changes
  useEffect(() => {
    setValue('');
    setOperator('eq');
  }, [selectedPropName]);

  const operators = selectedProp ? operatorsFor(selectedProp) : [];
  const hasChoices = !!selectedProp?.possibleValues?.length;

  // A bbox drawn on the map arrives from above — reflect it in the coordinate box
  useEffect(() => {
    if (spatial?.shape.kind !== 'bbox') return;
    const extent = spatial.shape.extent;
    const current = parseExtent(bboxText);
    const unchanged = current?.every((n, i) => Math.abs(n - extent[i]) < 1e-6);
    if (!unchanged) {
      setSpatialMode('bbox');
      setBboxText(formatExtent(extent));
      setSpatialError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spatial]);

  /** The geometry this panel parsed, so a drawn one can be told apart from it. */
  const ownGeometryRef = useRef<Geometry | null>(null);

  // A shape drawn on the map arrives the same way — write it back out as text
  useEffect(() => {
    if (spatial?.shape.kind !== 'geometry' || spatial.shape.geometry === ownGeometryRef.current) {
      return;
    }
    ownGeometryRef.current = spatial.shape.geometry;
    setSpatialMode('geojson');
    setGeoJsonText(geometryToGeoJson(spatial.shape.geometry, geoJsonCrs, wfs.srsName));
    setSpatialError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spatial]);

  /** Back to a bare fetch-all: no attribute condition, no spatial constraint. */
  function clearFilter() {
    setSelectedPropName('');
    setValue('');
    setOperator('eq');
    selectMode('none');
  }

  function selectMode(mode: SpatialMode) {
    setSpatialMode(mode);
    setSpatialError(null);
    if (mode === 'none') onSpatialChange(null);
    else if (mode === 'bbox') applyBboxText(bboxText);
    else applyGeoJson(geoJsonText, geoJsonCrs);
  }

  function applyBboxText(text: string) {
    setBboxText(text);
    if (text.trim() === '') {
      setSpatialError(null);
      onSpatialChange(null);
      return;
    }
    const extent = parseExtent(text);
    if (!extent) {
      setSpatialError(`Expected 4 numbers in ${wfs.srsName}: minX, minY, maxX, maxY`);
      return;
    }
    setSpatialError(null);
    onSpatialChange(withShape(spatial, { kind: 'bbox', extent }));
  }

  function applyGeoJson(text: string, crs: string) {
    setGeoJsonText(text);
    setGeoJsonCrs(crs);
    if (text.trim() === '') {
      setSpatialError(null);
      onSpatialChange(null);
      return;
    }
    try {
      const geometry = parseGeoJsonGeometry(text, crs, wfs.srsName);
      ownGeometryRef.current = geometry;
      onSpatialChange(withShape(spatial, { kind: 'geometry', geometry }));
      setSpatialError(null);
    } catch (e) {
      setSpatialError(e instanceof Error ? e.message : String(e));
    }
  }

  // No filter is required — a layer alone fetches everything up to the cap.
  const attributeReady = !!selectedProp && value.trim() !== '';
  const canRun = !!selectedLayerName && !running;

  const spec: QuerySpec | null = selectedLayerName
    ? {
        layerName: selectedLayerName,
        ...(attributeReady ? { property: selectedProp, operator, value: value.trim() } : {}),
        ...(spatial ? { spatial } : {}),
        maxFeatures,
      }
    : null;

  const generatedXml = useMemo(() => {
    if (!spec) return '';
    try {
      return buildGetFeatureXml(wfs, spec);
    } catch (e) {
      return `<!-- ${e instanceof Error ? e.message : String(e)} -->`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfs, selectedLayerName, selectedProp, operator, value, spatial, maxFeatures, attributeReady]);

  /** What "Run query" would POST — the hand-edited document when there is one. */
  const requestBody = editedXml ?? generatedXml;

  const [curlState, setCurlState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyAsCurl() {
    if (!requestBody) return;
    setCurlState((await copyText(toCurlCommand(wfs, requestBody))) ? 'copied' : 'failed');
    setTimeout(() => setCurlState('idle'), 1600);
  }

  return (
    <section className="panel-block">
      {servers.length > 0 && (
        <div className="field col-full">
          <label htmlFor="server-select">GeoServer</label>
          <select id="server-select" value={serverIndex} onChange={(e) => onServerChange(Number(e.target.value))}>
            {servers.map((s, i) => (
              <option key={s.name} value={i}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="hint mono" dir="ltr">
            {wfs.url}
          </span>
        </div>
      )}

      <div className="field">
        <label htmlFor="layer-select">Layer</label>
        <select id="layer-select" value={selectedLayerName} onChange={(e) => setSelectedLayerName(e.target.value)}>
          <option value="">Select a layer…</option>
          {sortedLayers.map((l) => (
            <option key={l.layerName} value={l.layerName}>
              {layerLabel(l)}
            </option>
          ))}
        </select>
        {selectedLayerName && (
          <span className="hint mono" dir="ltr">
            {selectedLayerName}
          </span>
        )}
        {layersError && <span className="error">Failed to load layers: {layersError}</span>}
      </div>

      <div className="field">
        <label htmlFor="prop-select">Field</label>
        <div className="field-row">
          <select id="prop-select" value={selectedPropName} onChange={(e) => setSelectedPropName(e.target.value)} disabled={!detail || detailLoading}>
            <option value="">{detailLoading ? 'Loading fields…' : 'Select a field…'}</option>
            {queryableProps.map((p) => (
              <option key={p.property} value={p.property}>
                {propertyLabel(p)}
              </option>
            ))}
          </select>
          {selectedPropName && (
            <button
              type="button"
              className="btn-ghost btn-field-clear"
              title="Remove the property filter"
              aria-label="Remove the property filter"
              onClick={() => setSelectedPropName('')}
            >
              ×
            </button>
          )}
        </div>
        {selectedProp && (
          <span className="hint mono" dir="ltr">
            {selectedProp.property} · {selectedProp.type}
          </span>
        )}
        {detailError && <span className="error">Failed to load fields: {detailError}</span>}
      </div>

      {selectedProp && (
        <div className="field-row col-full">
          <div className="field field-op">
            <label htmlFor="op-select">Operator</label>
            <select id="op-select" value={operator} onChange={(e) => setOperator(e.target.value as OperatorId)}>
              {operators.map((op) => (
                <option key={op.id} value={op.id}>
                  {op.label} ({op.symbol})
                </option>
              ))}
            </select>
          </div>

          <div className="field field-value">
            <label htmlFor="value-input">Value</label>
            {hasChoices ? (
              <select id="value-input" value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Select a value…</option>
                {[...selectedProp.possibleValues!]
                  .sort((a, b) => a.localeCompare(b))
                  .map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
              </select>
            ) : (
              <input
                id="value-input"
                type={isNumericType(selectedProp.type) ? 'number' : isDateType(selectedProp.type) ? 'datetime-local' : 'text'}
                value={value}
                placeholder={isNumericType(selectedProp.type) ? '123' : 'text to match'}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </div>
        </div>
      )}

      <div className="field col-full">
        <label>Spatial filter</label>
        <div className="segmented">
          {(
            [
              ['none', 'None'],
              ['bbox', 'Bounding box'],
              ['geojson', 'GeoJSON'],
            ] as [SpatialMode, string][]
          ).map(([mode, label]) => (
            <button key={mode} type="button" className={spatialMode === mode ? 'segment segment-active' : 'segment'} onClick={() => selectMode(mode)}>
              {label}
            </button>
          ))}
        </div>

        {spatialMode === 'bbox' && (
          <>
            <div className="bbox-actions">
              <button type="button" className={drawing === 'bbox' ? 'btn-primary' : 'btn-ghost'} onClick={() => onDraw('bbox')}>
                {drawing === 'bbox' ? 'Drag on the map…' : 'Draw box'}
              </button>
              <button type="button" className="btn-ghost" onClick={onUseViewExtent}>
                Current view
              </button>
            </div>
            <input className="mono" value={bboxText} placeholder="minX, minY, maxX, maxY" onChange={(e) => applyBboxText(e.target.value)} />
            <span className="hint">Coordinates in {wfs.srsName}</span>
          </>
        )}

        {spatialMode === 'geojson' && (
          <>
            <div className="bbox-actions">
              <button type="button" className={drawing === 'polygon' ? 'btn-primary' : 'btn-ghost'} onClick={() => onDraw('polygon')}>
                {drawing === 'polygon' ? 'Click, double-click to end…' : 'Draw polygon'}
              </button>
            </div>
            {spatial?.shape.kind === 'geometry' && (
              <span className="hint">
                The shape is editable on the map: drag a node to move it, drag an edge to add one, Alt-click a node to delete it
              </span>
            )}
            <Suspense fallback={<div className="xml-editor code-editor-short xml-editor-loading">Loading editor…</div>}>
              <CodeEditor value={geoJsonText} language="json" onChange={(text) => applyGeoJson(text, geoJsonCrs)} className="code-editor-short" />
            </Suspense>
            <div className="field-row">
              <select value={geoJsonCrs} onChange={(e) => applyGeoJson(geoJsonText, e.target.value)} aria-label="GeoJSON coordinate reference system">
                <option value={GEOJSON_DEFAULT_CRS}>{GEOJSON_DEFAULT_CRS} (lon/lat)</option>
                {/* the two coincide when the WFS itself speaks WGS84 */}
                {wfs.srsName !== GEOJSON_DEFAULT_CRS && <option value={wfs.srsName}>{wfs.srsName} (map units)</option>}
              </select>
            </div>
            <span className="hint">Geometry, Feature or FeatureCollection — sent as an INTERSECTS filter</span>
          </>
        )}

        {spatial && (
          <>
            <div className="field-row">
              <div className="field field-op">
                <label htmlFor="spatial-op">Predicate</label>
                <select
                  id="spatial-op"
                  value={spatial.operator}
                  onChange={(e) =>
                    onSpatialChange({
                      ...spatial,
                      operator: e.target.value as SpatialOperatorId,
                    })
                  }
                >
                  {spatialOperatorsFor(spatial.shape.kind).map((op) => (
                    <option key={op.id} value={op.id}>
                      {op.label}
                    </option>
                  ))}
                </select>
              </div>

              {spatial.operator === 'dwithin' && (
                <div className="field field-value">
                  <label htmlFor="spatial-distance">Distance</label>
                  <div className="field-row">
                    <input
                      id="spatial-distance"
                      type="number"
                      min={0}
                      value={spatial.distance ?? DEFAULT_DISTANCE}
                      onChange={(e) =>
                        onSpatialChange({
                          ...spatial,
                          distance: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                    />
                    <select
                      aria-label="Distance unit"
                      className="field-unit"
                      value={spatial.unit ?? DEFAULT_UNIT}
                      onChange={(e) => onSpatialChange({ ...spatial, unit: e.target.value })}
                    >
                      {DISTANCE_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
            <span className="hint">
              Features whose {wfs.geometryName ?? DEFAULT_GEOMETRY_NAME} {SPATIAL_OPERATORS.find((o) => o.id === spatial.operator)?.hint}
            </span>
          </>
        )}

        {spatialError && <span className="error">{spatialError}</span>}
      </div>

      <div className="field">
        <label htmlFor="max-input">Max results</label>
        <input
          id="max-input"
          type="number"
          min={1}
          max={5000}
          value={maxFeatures}
          onChange={(e) => setMaxFeatures(Math.max(1, Number(e.target.value) || 1))}
        />
      </div>

      <div className="field">
        <label htmlFor="version-select">WFS version</label>
        <select id="version-select" value={wfs.version ?? '1.1.0'} onChange={(e) => onVersionChange(e.target.value)}>
          {WFS_VERSIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-preview col-full" aria-live="polite">
        <div className="filter-preview-head">
          <span className="filter-preview-label">WFS FILTER</span>
          {(attributeReady || spatial) && (
            <button
              type="button"
              className="filter-clear"
              title="Remove the filter — query the whole layer"
              aria-label="Remove the filter"
              onClick={clearFilter}
            >
              ×
            </button>
          )}
        </div>
        <code>{spec ? filterPreview(spec, wfs.geometryName ?? DEFAULT_GEOMETRY_NAME) : '—'}</code>
      </div>

      <div className="field col-full">
        <button type="button" className="disclosure" onClick={() => setShowRequest((s) => !s)} aria-expanded={showRequest}>
          {showRequest ? '▾' : '▸'} GetFeature request
          {editedXml !== null && <span className="badge">edited</span>}
        </button>

        {showRequest && (
          <>
            <Suspense fallback={<div className="xml-editor xml-editor-tall xml-editor-loading">Loading editor…</div>}>
              {editedXml === null ? (
                // read-only until "Edit manually" — the generated document
                // regenerates under the reader as the fields change. The keys
                // matter: read-only is fixed at creation, so swapping modes
                // must swap editors.
                <CodeEditor key="generated" value={generatedXml} language="xml" className="xml-editor-tall" />
              ) : (
                <CodeEditor key="edited" value={editedXml} language="xml" onChange={setEditedXml} className="xml-editor-tall" />
              )}
            </Suspense>
            <div className="bbox-actions">
              {editedXml === null ? (
                <button type="button" className="btn-ghost" disabled={!generatedXml} onClick={() => setEditedXml(generatedXml)}>
                  Edit manually
                </button>
              ) : (
                <button type="button" className="btn-ghost" onClick={() => setEditedXml(null)}>
                  Discard edits
                </button>
              )}
              <button type="button" className="btn-ghost" disabled={!requestBody} onClick={() => void copyAsCurl()}>
                {curlState === 'copied' ? 'Copied' : curlState === 'failed' ? 'Copy failed' : 'Copy as cURL'}
              </button>
            </div>
            <span className="hint">
              {editedXml === null ? 'Generated from the filter above' : 'Sent verbatim — the fields above no longer apply'}
            </span>
          </>
        )}
      </div>

      <div className="actions col-full">
        <button className="btn-primary" disabled={!canRun} onClick={() => spec && onRun(spec, editedXml ?? undefined)}>
          {running ? 'Running…' : 'Run query'}
        </button>
        <button
          className="btn-ghost"
          onClick={() => {
            setEditedXml(null);
            onClear();
          }}
        >
          Clear
        </button>
      </div>
    </section>
  );
}

/** "1, 2, 3, 4" or "1 2 3 4" → an extent, or null when it isn't four numbers. */
function parseExtent(text: string): Extent | null {
  const parts = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}
