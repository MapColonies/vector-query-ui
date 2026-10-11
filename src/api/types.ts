export interface LayerSummary {
  layerName: string;
  alias?: string;
}

export interface LayersResponse {
  layers: LayerSummary[];
}

export interface LayerProperty {
  property: string;
  /** e.g. "xsd:long", "xsd:string", "xsd:double", "xsd:dateTime", "gml:PolygonPropertyType" */
  type: string;
  alias?: string;
  possibleValues?: string[];
}

export interface LayerDetail {
  layerName: string;
  alias?: string;
  properties: LayerProperty[];
}

/** Display label rule used across the app: alias first, fall back to the raw name. */
export function layerLabel(l: LayerSummary): string {
  return l.alias?.trim() || l.layerName;
}

export function propertyLabel(p: LayerProperty): string {
  return p.alias?.trim() || p.property;
}

export function isGeometryProperty(p: LayerProperty): boolean {
  return p.type.startsWith("gml:");
}
