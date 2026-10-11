import { useMemo } from 'react';
import type Feature from 'ol/Feature';

interface Props {
  feature: Feature | null;
}

interface Elevation {
  property: string;
  values: number[];
  min: number;
  max: number;
}

/** Flattens any nesting of coordinates down to the individual positions. */
function positions(input: unknown): number[][] {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (typeof input[0] === 'number') return [input as number[]];
  return (input as unknown[]).flatMap(positions);
}

/**
 * The Z ordinates of whichever property carries three-dimensional geometry.
 * Found by looking rather than by name: the column is declared in the layer's
 * own Lua, so nothing here should have to know it is called geom3d.
 */
function findElevation(feature: Feature | null): Elevation | null {
  if (!feature) return null;

  for (const [property, value] of Object.entries(feature.getProperties())) {
    const geometry = value as { getCoordinates?: () => unknown } | null;
    if (!geometry || typeof geometry.getCoordinates !== 'function') continue;

    const coords = positions(geometry.getCoordinates());
    if (coords.length === 0 || coords.some((c) => c.length < 3)) continue;

    const values = coords.map((c) => c[2]).filter((z) => Number.isFinite(z));
    if (values.length === 0) continue;

    return { property, values, min: Math.min(...values), max: Math.max(...values) };
  }
  return null;
}

export default function ElevationProfile({ feature }: Props) {
  const elevation = useMemo(() => findElevation(feature), [feature]);
  if (!elevation) return null;

  const { property, values, min, max } = elevation;
  const span = max - min;
  const width = 260;
  const height = 48;

  // A flat feature would divide by zero and draw nothing; draw it down the
  // middle instead, which is what a constant elevation looks like.
  const points = values
    .map((z, i) => {
      const x = values.length === 1 ? width / 2 : (i / (values.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - ((z - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <section className="elevation">
      <div className="elevation-header">
        <span>Elevation</span>
        <span className="elevation-property mono" dir="ltr">
          {property}
        </span>
      </div>

      <svg
        className="elevation-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Elevation from ${min} to ${max} metres across ${values.length} vertices`}
      >
        <polyline points={points} fill="none" />
      </svg>

      <dl className="elevation-stats">
        <div>
          <dt>min</dt>
          <dd className="mono">{min.toFixed(2)} m</dd>
        </div>
        <div>
          <dt>max</dt>
          <dd className="mono">{max.toFixed(2)} m</dd>
        </div>
        <div>
          <dt>range</dt>
          <dd className="mono">{span.toFixed(2)} m</dd>
        </div>
        <div>
          <dt>vertices</dt>
          <dd className="mono">{values.length}</dd>
        </div>
      </dl>
    </section>
  );
}
