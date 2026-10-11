import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type Feature from 'ol/Feature';
import { propertyLabel, type LayerProperty } from '../api/types';
import { featureToGeoJson } from '../query/geojson';
import CopyButton from './CopyButton';

// Monaco is heavy — fetched the first time a feature is actually inspected.
// Its folding gutter is what makes the document's {} and [] collapsible.
const CodeEditor = lazy(async () => import('./CodeEditor'));

interface Props {
  features: Feature[];
  properties: LayerProperty[];
  selected: Feature | null;
  /** Projection the features are in — needed to write WGS84 GeoJSON. */
  featureProjection: string;
  onSelect: (f: Feature) => void;
}

const MAX_COLUMNS = 4;

export default function ResultsTable({ features, properties, selected, featureProjection, onSelect }: Props) {
  // Prefer columns that actually carry data, name-like fields first.
  const columns = useMemo(() => {
    const nonGeom = properties.filter((p) => !p.type.startsWith('gml:'));
    const scored = nonGeom.map((p) => {
      const filled = features.filter((f) => {
        const v: unknown = f.get(p.property);
        return v !== undefined && v !== null && v !== '';
      }).length;
      const nameBoost = /name|alias|title|label/i.test(p.property) ? features.length : 0;
      return { p, score: filled + nameBoost };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_COLUMNS)
      .map((s) => s.p);
  }, [features, properties]);

  const selectedGeoJson = useMemo(() => (selected ? featureToGeoJson(selected, featureProjection) : ''), [selected, featureProjection]);

  // a feature picked on the map may be far down the list
  const selectedRowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  const [open, setOpen] = useState(true);
  const [detailOpen, setDetailOpen] = useState(true);

  // A fresh query reopens the list — collapsing is for reading what is below,
  // not a preference that should hide the next answer.
  useEffect(() => {
    if (features.length > 0) setOpen(true);
  }, [features]);

  if (features.length === 0) return null;

  return (
    <section className="results">
      <button className="exchange-toggle" onClick={() => setOpen((o) => !o)}>
        <span>{open ? '▾' : '▸'} Results</span>
        <span className="results-count mono">{features.length}</span>
      </button>

      {open && (
        <>
          <div className="results-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.property}>{propertyLabel(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {features.map((f, i) => (
                  <tr
                    key={f.getId() ?? i}
                    ref={f === selected ? selectedRowRef : undefined}
                    className={f === selected ? 'row-selected' : ''}
                    onClick={() => onSelect(f)}
                  >
                    {columns.map((c) => {
                      const v: unknown = f.get(c.property);
                      return <td key={c.property}>{v === undefined || v === null ? '—' : String(v)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Alongside the table rather than inside it: a code block nested in
              the scrolling table would put one scrollbar inside another. The
              response view below keeps its own tabs either way. */}
          {selected && (
            <div className="results-detail">
              <div className="results-detail-header">
                <button className="exchange-toggle" onClick={() => setDetailOpen((o) => !o)}>
                  <span>{detailOpen ? '▾' : '▸'} Selected feature</span>
                </button>
                <CopyButton text={selectedGeoJson} className="btn-ghost btn-inline" />
              </div>
              {detailOpen && (
                <Suspense fallback={<div className="xml-editor code-editor-detail xml-editor-loading">Loading editor…</div>}>
                  <CodeEditor value={selectedGeoJson} language="json" className="code-editor-detail" />
                </Suspense>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
