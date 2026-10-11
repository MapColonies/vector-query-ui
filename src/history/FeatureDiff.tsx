import { useMemo } from "react";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import { getArea, getDistance, getLength } from "ol/sphere";
import { getCenter } from "ol/extent";
import { transform } from "ol/proj";
import { propertyLabel, type LayerProperty } from "../api/types";

export type DiffSlot = "a" | "b";

interface Props {
  a: Feature<Geometry> | null;
  b: Feature<Geometry> | null;
  selected: Feature<Geometry> | null;
  properties: LayerProperty[];
  featureProjection: string;
  onPin: (slot: DiffSlot, feature: Feature<Geometry> | null) => void;
}

interface GeomSummary {
  type: string;
  area: number | null;
  length: number | null;
}

function summarise(
  feature: Feature<Geometry> | null,
  projection: string
): GeomSummary | null {
  const geom = feature?.getGeometry();
  if (!geom) return null;
  const type = geom.getType();
  const isArea = type === "Polygon" || type === "MultiPolygon";
  const isLine = type === "LineString" || type === "MultiLineString";
  return {
    type,
    area: isArea ? getArea(geom, { projection }) : null,
    length: isLine ? getLength(geom, { projection }) : null
  };
}

function centreShift(
  a: Feature<Geometry> | null,
  b: Feature<Geometry> | null,
  projection: string
): number | null {
  const ga = a?.getGeometry();
  const gb = b?.getGeometry();
  if (!ga || !gb) return null;
  const pa = transform(getCenter(ga.getExtent()), projection, "EPSG:4326");
  const pb = transform(getCenter(gb.getExtent()), projection, "EPSG:4326");
  return getDistance(pa, pb);
}

function shape(feature: Feature<Geometry> | null): string | null {
  const geom = feature?.getGeometry();
  if (!geom) return null;
  const asAny = geom as unknown as { getCoordinates?: () => unknown };
  if (typeof asAny.getCoordinates !== "function") return null;
  return JSON.stringify(asAny.getCoordinates());
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

function metres(value: number | null): string {
  if (value === null) return "—";
  return value >= 10000
    ? `${(value / 1000).toFixed(2)} km`
    : `${value.toFixed(1)} m`;
}

export default function FeatureDiff({
  a,
  b,
  selected,
  properties,
  featureProjection,
  onPin
}: Props) {
  const rows = useMemo(() => {
    if (!a || !b) return [];
    return properties
      .filter((p) => !p.type.startsWith("gml:"))
      .map((p) => {
        const left = a.get(p.property);
        const right = b.get(p.property);
        return {
          property: p,
          left,
          right,
          changed: String(left ?? "") !== String(right ?? "")
        };
      });
  }, [a, b, properties]);

  const sa = summarise(a, featureProjection);
  const sb = summarise(b, featureProjection);
  const moved = centreShift(a, b, featureProjection);
  const sameShape = a && b ? shape(a) === shape(b) : null;
  const changedCount = rows.filter((r) => r.changed).length;

  return (
    <section className="diff">
      <div className="diff-header">
        <span>Compare</span>
        {a && b && (
          <span className="diff-count mono">
            {changedCount} of {rows.length} fields differ
          </span>
        )}
      </div>

      <div className="diff-slots">
        {(["a", "b"] as DiffSlot[]).map((slot) => {
          const pinned = slot === "a" ? a : b;
          return (
            <div key={slot} className={`diff-slot${pinned ? " is-filled" : ""}`}>
              <span className="diff-slot-label">{slot.toUpperCase()}</span>
              <span className="diff-slot-value mono">
                {pinned ? show(pinned.getId() ?? "feature") : "empty"}
              </span>
              <button
                className="btn-ghost btn-tiny"
                disabled={!selected}
                onClick={() => onPin(slot, selected)}
                title="Pin the currently selected feature or version here"
              >
                pin
              </button>
              <button
                className="btn-ghost btn-tiny"
                disabled={!pinned}
                onClick={() => onPin(slot, null)}
              >
                clear
              </button>
            </div>
          );
        })}
      </div>

      {!a || !b ? (
        <div className="diff-empty">
          Select a feature or a history version, then pin it to A and B.
        </div>
      ) : (
        <>
          <table className="diff-table">
            <tbody>
              <tr className={sameShape ? "" : "is-changed"}>
                <th>geometry</th>
                <td colSpan={2}>
                  {sameShape ? "identical" : "differs"}
                  {sa?.area !== null && sb?.area != null && (
                    <span className="diff-metric">
                      {" "}
                      {Math.round(sa!.area!)} → {Math.round(sb.area)} m²
                    </span>
                  )}
                  {sa?.length != null && sb?.length != null && (
                    <span className="diff-metric">
                      {" "}
                      {metres(sa.length)} → {metres(sb.length)}
                    </span>
                  )}
                  {moved !== null && moved > 0.05 && (
                    <span className="diff-metric"> · centre {metres(moved)}</span>
                  )}
                </td>
              </tr>
              {rows.map((r) => (
                <tr
                  key={r.property.property}
                  className={r.changed ? "is-changed" : ""}
                >
                  <th title={r.property.property}>{propertyLabel(r.property)}</th>
                  <td>{show(r.left)}</td>
                  <td>{show(r.right)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {changedCount === 0 && sameShape && (
            <div className="diff-empty">
              These two are identical in every published column.
            </div>
          )}
        </>
      )}
    </section>
  );
}
