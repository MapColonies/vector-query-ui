import GeoJSON from 'ol/format/GeoJSON';
import type Feature from 'ol/Feature';
import type Geometry from 'ol/geom/Geometry';

const JSON_INDENT = 2;

/** RFC 7946 says GeoJSON coordinates are WGS84 longitude/latitude. */
export const GEOJSON_DEFAULT_CRS = 'EPSG:4326';

/**
 * Reads a Geometry, Feature or FeatureCollection and returns the geometry in
 * `targetProjection`. A collection contributes its first feature's geometry —
 * WFS spatial operators take a single geometry.
 */
export function parseGeoJsonGeometry(text: string, sourceProjection: string, targetProjection: string): Geometry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }

  const format = new GeoJSON();
  const options = { dataProjection: sourceProjection, featureProjection: targetProjection };
  const type = (parsed as { type?: string } | null)?.type;

  if (type === 'FeatureCollection') {
    const features = format.readFeatures(parsed, options) as Feature[];
    const geometry = features[0]?.getGeometry();
    if (!geometry) throw new Error('FeatureCollection has no geometry');
    return geometry;
  }
  if (type === 'Feature') {
    const geometry = format.readFeature(parsed, options) as Feature;
    const g = geometry.getGeometry();
    if (!g) throw new Error('Feature has no geometry');
    return g;
  }
  if (typeof type === 'string') {
    const geometry = format.readGeometry(parsed, options);
    if (!geometry) throw new Error('Geometry is empty');
    return geometry;
  }
  throw new Error('Missing "type" — expected a Geometry, Feature or FeatureCollection');
}

/**
 * Writes a geometry back out as GeoJSON in `targetCrs` — the round trip for a
 * shape drawn on the map, which lands in the view's projection.
 */
export function geometryToGeoJson(geometry: Geometry, targetCrs: string, sourceProjection: string): string {
  return JSON.stringify(
    new GeoJSON().writeGeometryObject(geometry, {
      featureProjection: sourceProjection,
      dataProjection: targetCrs,
      decimals: 6,
    }),
    null,
    JSON_INDENT
  );
}

/** Serializes query results as WGS84 GeoJSON for the response viewer. */
export function featuresToGeoJson(features: Feature[], featureProjection: string): string {
  return JSON.stringify(
    new GeoJSON().writeFeaturesObject(features, {
      featureProjection,
      dataProjection: GEOJSON_DEFAULT_CRS,
    }),
    null,
    JSON_INDENT
  );
}

export function featureToGeoJson(feature: Feature, featureProjection: string): string {
  return JSON.stringify(
    new GeoJSON().writeFeatureObject(feature, {
      featureProjection,
      dataProjection: GEOJSON_DEFAULT_CRS,
    }),
    null,
    JSON_INDENT
  );
}
