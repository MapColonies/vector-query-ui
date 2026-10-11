import WFS from "ol/format/WFS";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import {
  and,
  bbox as bboxFilter,
  contains,
  disjoint,
  dwithin,
  intersects,
  within,
  equalTo,
  greaterThan,
  greaterThanOrEqualTo,
  lessThan,
  lessThanOrEqualTo,
  like,
  not,
  notEqualTo
} from "ol/format/filter";
import type Filter from "ol/format/filter/Filter";
import { get as getProjection } from "ol/proj";
import type { Extent } from "ol/extent";
import { credentialHeaders } from "../config";
import type { WfsConfig } from "../config";
import { fromExtent } from "ol/geom/Polygon";
import type { LayerProperty } from "../api/types";
import { isNumericType, type OperatorId, type SpatialOperatorId } from "./operators";

/**
 * The shape to test against — an extent dragged out on the map, or an arbitrary
 * geometry such as a pasted or drawn polygon — plus the predicate to test with.
 * Coordinates are always in `wfs.srsName` units by the time they get here.
 *
 * Only BBOX needs the extent as such; every other predicate takes a geometry,
 * so a box is sent as its polygon.
 */
export interface SpatialFilter {
  shape: { kind: "bbox"; extent: Extent } | { kind: "geometry"; geometry: Geometry };
  operator: SpatialOperatorId;
  /** DWithin only. */
  distance?: number;
  unit?: string;
}

export const DEFAULT_DISTANCE = 100;
export const DEFAULT_UNIT = "m";

/** What the map outlines, whichever way the shape was given. */
export function spatialGeometry(spatial: SpatialFilter): Geometry {
  return spatial.shape.kind === "bbox" ? fromExtent(spatial.shape.extent) : spatial.shape.geometry;
}

/**
 * Replaces the shape, keeping the predicate that was chosen for it — unless it
 * no longer applies, since only a box has an envelope for BBOX to test.
 */
export function withShape(
  current: SpatialFilter | null,
  shape: SpatialFilter["shape"]
): SpatialFilter {
  const operator = current?.operator ?? (shape.kind === "bbox" ? "bbox" : "intersects");
  return {
    shape,
    operator: shape.kind === "geometry" && operator === "bbox" ? "intersects" : operator,
    distance: current?.distance,
    unit: current?.unit
  };
}

export interface QuerySpec {
  layerName: string;
  /** Attribute condition. Optional — a query may be spatial-only. */
  property?: LayerProperty;
  operator?: OperatorId;
  value?: string;
  spatial?: SpatialFilter;
  maxFeatures: number;
}

export const DEFAULT_GEOMETRY_NAME = "geom";

/**
 * The CRS to name on the wire, which is not always the one we call it by.
 *
 * WFS 1.1.0 orders coordinates by the CRS's own axis definition, and servers
 * disagree about what a bare "EPSG:4326" means: GeoServer answers it lon/lat
 * but labels the response `.../gml/srs/epsg.xml#4326`, a code OpenLayers reads
 * as lat/lon — so every feature comes back transposed, and our BBOX goes out
 * transposed too. The OGC URN form is unambiguous to both (lat/lon for 4326,
 * easting/northing for a projected CRS) and OpenLayers resolves it back to the
 * same projection, so only the label changes. WFS 1.0.0 is always lon/lat and
 * predates the URN form, so it is left alone.
 */
export function requestSrsName(cfg: WfsConfig): string {
  const epsg = /^EPSG:(\d+)$/.exec(cfg.srsName);
  if (!epsg || (cfg.version ?? "1.1.0").startsWith("1.0")) return cfg.srsName;
  return `urn:ogc:def:crs:EPSG::${epsg[1]}`;
}

function coerce(property: LayerProperty, value: string): string | number {
  if (isNumericType(property.type)) {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`Not a number: "${value}"`);
    return n;
  }
  return value;
}

/** Dates travel as ISO strings; OL's typings expect number for range operators. */
function asComparable(v: string | number): number {
  return v as unknown as number;
}

function attributeFilter(property: LayerProperty, operator: OperatorId, value: string): Filter {
  const prop = property.property;
  const v = coerce(property, value);
  switch (operator) {
    case "eq":
      return equalTo(prop, v);
    case "neq":
      return notEqualTo(prop, v);
    case "gt":
      return greaterThan(prop, asComparable(v));
    case "gte":
      return greaterThanOrEqualTo(prop, asComparable(v));
    case "lt":
      return lessThan(prop, asComparable(v));
    case "lte":
      return lessThanOrEqualTo(prop, asComparable(v));
    case "like":
      return like(prop, `*${String(v)}*`, "*", ".", "!", false);
    default:
      return not(equalTo(prop, v)); // unreachable, keeps switch exhaustive at runtime
  }
}

/**
 * OpenLayers orders GML geometry coordinates by the CRS's axes but writes
 * `<gml:Envelope>` corners verbatim, so a bbox headed for a lat/lon CRS has to
 * be transposed here — otherwise the Intersects and BBOX filters disagree.
 * Everywhere else in the app an extent stays x/y.
 */
function axisOrder(extent: Extent, srsName: string): Extent {
  const orientation = getProjection(srsName)?.getAxisOrientation() ?? "enu";
  return orientation.startsWith("en")
    ? extent
    : [extent[1], extent[0], extent[3], extent[2]];
}

function spatialFilter(cfg: WfsConfig, spatial: SpatialFilter): Filter {
  const geomName = cfg.geometryName ?? DEFAULT_GEOMETRY_NAME;
  const srsName = requestSrsName(cfg);

  if (spatial.operator === "bbox" && spatial.shape.kind === "bbox") {
    return bboxFilter(geomName, axisOrder(spatial.shape.extent, srsName), srsName);
  }

  const geometry = spatialGeometry(spatial);
  switch (spatial.operator) {
    case "within":
      return within(geomName, geometry, srsName);
    case "contains":
      return contains(geomName, geometry, srsName);
    case "disjoint":
      return disjoint(geomName, geometry, srsName);
    case "dwithin":
      return dwithin(
        geomName,
        geometry,
        spatial.distance ?? DEFAULT_DISTANCE,
        spatial.unit ?? DEFAULT_UNIT,
        srsName
      );
    default:
      // "intersects", and BBOX asked for on a shape that has no envelope form
      return intersects(geomName, geometry, srsName);
  }
}

/**
 * The attribute condition and the spatial one are ANDed together; either on its
 * own is a valid query. Returns undefined when neither is set (fetch-all).
 */
export function buildFilter(cfg: WfsConfig, spec: QuerySpec): Filter | undefined {
  const filters: Filter[] = [];
  if (spec.property && spec.value !== undefined && spec.value !== "") {
    filters.push(attributeFilter(spec.property, spec.operator ?? "eq", spec.value));
  }
  if (spec.spatial) {
    filters.push(spatialFilter(cfg, spec.spatial));
  }
  if (filters.length === 0) return undefined;
  return filters.length === 1 ? filters[0] : and(...filters);
}

/**
 * Coordinates are in `wfs.srsName` units — degrees for EPSG:4326, metres for
 * EPSG:3857. Rounding to whole units is right for metres and destroys degrees,
 * so keep decimals until the numbers are large enough not to need them.
 */
export function formatCoord(n: number): string {
  return Math.abs(n) >= 1000 ? String(Math.round(n)) : String(Number(n.toFixed(6)));
}

export function formatExtent(extent: Extent): string {
  return extent.map(formatCoord).join(", ");
}

/** Human-readable preview of the filter, e.g.  land_use = 'residential' AND BBOX(geom, …) */
export function filterPreview(
  spec: Partial<QuerySpec>,
  geometryName: string = DEFAULT_GEOMETRY_NAME
): string {
  const parts: string[] = [];

  if (spec.property) {
    const symbols: Record<OperatorId, string> = {
      eq: "=",
      neq: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      like: "LIKE"
    };
    const op = spec.operator ? symbols[spec.operator] : "=";
    const raw = spec.value ?? "";
    const value = isNumericType(spec.property.type)
      ? raw || "?"
      : `'${spec.operator === "like" ? `%${raw}%` : raw}'`;
    parts.push(`${spec.property.property} ${op} ${value}`);
  }

  if (spec.spatial) {
    const { shape, operator } = spec.spatial;
    const name = operator.toUpperCase();
    if (operator === "bbox" && shape.kind === "bbox") {
      parts.push(`BBOX(${geometryName}, ${formatExtent(shape.extent)})`);
    } else {
      const shapeName = shape.kind === "bbox" ? "Polygon" : shape.geometry.getType();
      const distance =
        operator === "dwithin"
          ? `, ${spec.spatial.distance ?? DEFAULT_DISTANCE}${spec.spatial.unit ?? DEFAULT_UNIT}`
          : "";
      parts.push(`${name}(${geometryName}, ${shapeName}${distance})`);
    }
  }

  return parts.length > 0 ? parts.join(" AND ") : "—";
}

/**
 * Capping the result set is spelled differently per version: WFS 1.x has
 * `maxFeatures`, 2.0.0 dropped it for `count`. OpenLayers writes whichever
 * option it is handed and never looks at the version, so naming the wrong one
 * still produces a well-formed request — the server just ignores the attribute
 * it does not know and answers in full, which reads as the limit not working
 * rather than as an error.
 */
function featureLimit(version: string, maxFeatures: number) {
  return version.startsWith("2.") ? { count: maxFeatures } : { maxFeatures };
}

export function buildGetFeatureXml(cfg: WfsConfig, spec: QuerySpec): string {
  const version = cfg.version ?? "1.1.0";
  const node = new WFS({ version }).writeGetFeature({
    srsName: requestSrsName(cfg),
    featureNS: cfg.featureNS,
    featurePrefix: cfg.featurePrefix,
    featureTypes: [spec.layerName],
    ...featureLimit(version, spec.maxFeatures),
    geometryName: cfg.geometryName,
    filter: buildFilter(cfg, spec)
  });
  return prettyXml(new XMLSerializer().serializeToString(node));
}

/**
 * The same POST as a runnable `curl`. The XML goes through a quoted heredoc so
 * it needs no escaping, and a same-origin `wfs.url` ("/geoserver/wfs") is
 * resolved against the page so the command works outside the browser.
 */
export function toCurlCommand(cfg: WfsConfig, requestXml: string): string {
  const url = new URL(cfg.url, window.location.origin).toString();
  const quote = (v: string) => v.replace(/'/g, "'\\''");
  const headers = { "Content-Type": "text/xml", ...credentialHeaders(cfg) };
  const body = requestXml.replace(/\s*\n\s*/g, "");
  return [
    `curl -X POST '${quote(url)}' \\`,
    ...Object.entries(headers).map(([k, v]) => `  -H '${k}: ${quote(v)}' \\`),
    `  --data-raw '${quote(body)}'`
  ].join("\n");
}

/** Indents serialized XML so the request/response are readable in the UI. */
export function prettyXml(xml: string, indent = "  "): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return xml;

  const lines: string[] = [];
  const serializer = new XMLSerializer();

  const walk = (node: Element, depth: number) => {
    const pad = indent.repeat(depth);
    const children = Array.from(node.children);
    if (children.length === 0) {
      lines.push(pad + serializer.serializeToString(node));
      return;
    }
    const open = serializer.serializeToString(node);
    // reconstruct just the start tag, attributes included
    const startTag = open.slice(0, open.indexOf(">") + 1);
    lines.push(pad + startTag);
    for (const child of children) walk(child, depth + 1);
    lines.push(`${pad}</${node.nodeName}>`);
  };

  if (!doc.documentElement) return xml;
  walk(doc.documentElement, 0);
  return lines.join("\n");
}

export interface QueryResult {
  features: Feature<Geometry>[];
  requestXml: string;
  responseXml: string;
}

/** Carries the exchange along, so a failed query is still inspectable. */
export class QueryError extends Error {
  constructor(
    message: string,
    readonly requestXml: string,
    readonly responseXml: string
  ) {
    super(message);
    this.name = "QueryError";
  }
}

/** POSTs `requestXml` verbatim — it may be the generated document or a hand-edited one. */
export async function executeQuery(
  cfg: WfsConfig,
  requestXml: string,
  signal?: AbortSignal
): Promise<QueryResult> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "text/xml", ...credentialHeaders(cfg) },
    body: requestXml,
    signal
  });
  const text = await res.text();
  if (!res.ok) {
    throw new QueryError(`WFS GetFeature failed (HTTP ${res.status})`, requestXml, text);
  }
  if (text.includes("ExceptionReport") || text.includes("ServiceException")) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const msg = doc.querySelector("ExceptionText, ServiceException")?.textContent?.trim();
    throw new QueryError(msg || "WFS returned a service exception", requestXml, text);
  }
  const features = new WFS({ version: cfg.version ?? "1.1.0" }).readFeatures(text, {
    dataProjection: cfg.srsName,
    featureProjection: cfg.srsName
  });
  return { features, requestXml, responseXml: text };
}
