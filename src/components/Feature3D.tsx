import { useMemo, useRef, useState } from 'react';
import type Feature from 'ol/Feature';

interface Props {
  feature: Feature | null;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Solid {
  property: string;
  faces: Vec3[][];
  lines: Vec3[][];
  zMin: number;
  zMax: number;
  vertices: number;
  height: number | null;
}

const HEIGHT_KEYS = ['relative_feature_height', 'height', 'building_height'];

function rings(input: unknown, depth: number): number[][][] {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (typeof input[0] === 'number') return [];
  if (typeof (input[0] as unknown[])[0] === 'number') return [input as number[][]];
  return (input as unknown[]).flatMap((v) => rings(v, depth + 1));
}

function findGeometry(feature: Feature): { property: string; coords: unknown; type: string } | null {
  for (const [property, value] of Object.entries(feature.getProperties())) {
    const g = value as { getCoordinates?: () => unknown; getType?: () => string } | null;
    if (!g || typeof g.getCoordinates !== 'function') continue;
    const coords = g.getCoordinates();
    const flat = rings(coords, 0);
    const probe = flat.length > 0 ? flat[0][0] : Array.isArray(coords) && typeof (coords as number[])[0] === 'number' ? (coords as number[]) : null;
    if (!probe || probe.length < 3 || !Number.isFinite(probe[2])) continue;
    return { property, coords, type: typeof g.getType === 'function' ? g.getType() : '' };
  }
  return null;
}

function heightOf(feature: Feature): number | null {
  const props = feature.getProperties();
  for (const key of HEIGHT_KEYS) {
    const raw: unknown = props[key];
    const n = typeof raw === 'string' ? Number(raw) : (raw as number);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function build(feature: Feature | null): Solid | null {
  if (!feature) return null;
  const found = findGeometry(feature);
  if (!found) return null;

  const polys = rings(found.coords, 0);
  const isPoint = polys.length === 0;
  const all: number[][] = isPoint ? [found.coords as number[]] : polys.flat();
  if (all.length === 0) return null;

  const lat0 = all.reduce((s, c) => s + c[1], 0) / all.length;
  const lon0 = all.reduce((s, c) => s + c[0], 0) / all.length;
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = 110540;
  const zs = all.map((c) => c[2]).filter(Number.isFinite);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);

  const to3 = (c: number[]): Vec3 => ({
    x: (c[0] - lon0) * mPerLon,
    y: (c[1] - lat0) * mPerLat,
    z: c[2] - zMin,
  });

  const height = heightOf(feature);
  const faces: Vec3[][] = [];
  const lines: Vec3[][] = [];

  if (isPoint) {
    const p = to3(found.coords as number[]);
    const s = Math.max(2, (zMax - zMin) * 0.15, 4);
    const h = height ?? s * 3;
    const box = [
      [-s, -s],
      [s, -s],
      [s, s],
      [-s, s],
    ].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy, z: p.z }));
    const top = box.map((v) => ({ ...v, z: v.z + h }));
    faces.push(top);
    for (let i = 0; i < box.length; i += 1) {
      const j = (i + 1) % box.length;
      faces.push([box[i], box[j], top[j], top[i]]);
    }
  } else if (
    found.type.includes('LineString') ||
    polys.some((r) => r.length > 1 && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]))
  ) {
    for (const ring of polys) lines.push(ring.map(to3));
    const drop = Math.max((zMax - zMin) * 0.25, 2);
    for (const ring of polys) {
      const path = ring.map(to3);
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = path[i];
        const b = path[i + 1];
        faces.push([{ ...a, z: a.z - drop }, { ...b, z: b.z - drop }, b, a]);
      }
    }
  } else {
    for (const ring of polys) {
      const base = ring.map(to3);
      if (height && height > 0) {
        const top = base.map((v) => ({ ...v, z: v.z + height }));
        faces.push(top);
        for (let i = 0; i < base.length - 1; i += 1) {
          faces.push([base[i], base[i + 1], top[i + 1], top[i]]);
        }
      } else {
        faces.push(base);
      }
      lines.push(base);
    }
  }

  return { property: found.property, faces, lines, zMin, zMax, vertices: all.length, height };
}

function shade(face: Vec3[]): number {
  if (face.length < 3) return 0.6;
  const [a, b, c] = face;
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const light = { x: -0.35, y: -0.5, z: 0.79 };
  const d = (n.x * light.x + n.y * light.y + n.z * light.z) / len;
  return 0.35 + Math.abs(d) * 0.6;
}

export default function Feature3D({ feature }: Props) {
  const solid = useMemo(() => build(feature), [feature]);
  const [yaw, setYaw] = useState(-0.6);
  const [pitch, setPitch] = useState(0.55);
  const drag = useRef<{ x: number; y: number } | null>(null);

  if (!solid) return null;

  const width = 260;
  const height = 170;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  const project = (p: Vec3) => {
    const X = p.x * cy - p.y * sy;
    const Y = p.x * sy + p.y * cy;
    return { sx: X, sy: -Y * sp - p.z * cp, depth: Y * cp - p.z * sp };
  };

  const projected = solid.faces.map((f) => f.map(project));
  const projLines = solid.lines.map((l) => l.map(project));
  const pts = [...projected.flat(), ...projLines.flat()];
  if (pts.length === 0) return null;

  const minX = Math.min(...pts.map((p) => p.sx));
  const maxX = Math.max(...pts.map((p) => p.sx));
  const minY = Math.min(...pts.map((p) => p.sy));
  const maxY = Math.max(...pts.map((p) => p.sy));
  const scale = Math.min(width / (maxX - minX || 1), height / (maxY - minY || 1)) * 0.82;
  const ox = width / 2 - ((minX + maxX) / 2) * scale;
  const oy = height / 2 - ((minY + maxY) / 2) * scale;
  const xy = (p: { sx: number; sy: number }) => `${(p.sx * scale + ox).toFixed(1)},${(p.sy * scale + oy).toFixed(1)}`;

  const ordered = projected.map((f, i) => ({ f, i, depth: f.reduce((s, p) => s + p.depth, 0) / f.length })).sort((a, b) => b.depth - a.depth);

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setYaw((v) => v + dx * 0.012);
    setPitch((v) => Math.max(-0.2, Math.min(1.5, v + dy * 0.012)));
  };
  const onUp = () => {
    drag.current = null;
  };

  return (
    <section className="feature3d">
      <div className="feature3d-header">
        <span>3D geometry</span>
        <span className="feature3d-property mono" dir="ltr">
          {solid.property}
        </span>
      </div>

      <svg
        className="feature3d-canvas"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Three dimensional view of ${solid.property}, drag to rotate`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {ordered.map(({ f, i }) => {
          const l = shade(solid.faces[i]);
          return (
            <polygon
              key={i}
              points={f.map(xy).join(' ')}
              fill={`hsl(207 68% ${(l * 62).toFixed(1)}%)`}
              stroke={`hsl(207 60% ${(l * 42).toFixed(1)}%)`}
              strokeWidth={0.6}
            />
          );
        })}
        {projLines.map((l, i) => (
          <polyline key={`l${i}`} className="feature3d-outline" points={l.map(xy).join(' ')} fill="none" />
        ))}
      </svg>

      <dl className="feature3d-stats">
        <div>
          <dt>base</dt>
          <dd className="mono">{solid.zMin.toFixed(2)} m</dd>
        </div>
        <div>
          <dt>top</dt>
          <dd className="mono">{(solid.height ? solid.zMax + solid.height : solid.zMax).toFixed(2)} m</dd>
        </div>
        {solid.height !== null && (
          <div>
            <dt>height</dt>
            <dd className="mono">{solid.height.toFixed(2)} m</dd>
          </div>
        )}
        <div>
          <dt>vertices</dt>
          <dd className="mono">{solid.vertices}</dd>
        </div>
      </dl>
    </section>
  );
}
