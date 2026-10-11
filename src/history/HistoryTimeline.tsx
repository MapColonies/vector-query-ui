import { useEffect, useMemo, useState } from 'react';
import type Feature from 'ol/Feature';
import type { HistoryConfig, WfsConfig } from '../config';
import { propertyLabel, type LayerProperty } from '../api/types';
import { buildGetFeatureXml, executeQuery } from '../query/wfs';

interface Props {
  wfs: WfsConfig;
  history: HistoryConfig;
  layerName: string;
  feature: Feature | null;
  properties: LayerProperty[];
  onShowVersion: (feature: Feature | null) => void;
}

interface Version {
  feature: Feature;
  from: string;
  to: string | null;
  changed: string[];
}

function formatInstant(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSpan(from: string, to: string | null): string {
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function HistoryTimeline({ wfs, history, layerName, feature, properties, onShowVersion }: Props) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  /** The first identity column this feature actually carries. */
  const identity = useMemo(() => {
    if (!feature) return null;
    for (const name of history.identityProperties) {
      const value: unknown = feature.get(name);
      if (value !== undefined && value !== null && value !== '') {
        const known = properties.find((p) => p.property === name);
        return { property: known ?? { property: name, type: 'xsd:string' }, value };
      }
    }
    return null;
  }, [feature, history.identityProperties, properties]);

  const comparable = useMemo(
    () =>
      properties
        .filter((p) => !p.type.startsWith('gml:'))
        .map((p) => p.property)
        .filter((p) => p !== history.validFromProperty && p !== history.validToProperty),
    [properties, history.validFromProperty, history.validToProperty]
  );

  useEffect(() => {
    setVersions([]);
    setActiveIndex(null);
    setError(null);
    onShowVersion(null);
    if (!feature || !identity) return;

    const versionedLayer = layerName.endsWith(history.versionedSuffix) ? layerName : `${layerName}${history.versionedSuffix}`;

    const controller = new AbortController();
    setLoading(true);

    const xml = buildGetFeatureXml(wfs, {
      layerName: versionedLayer,
      property: identity.property,
      operator: 'eq',
      value: String(identity.value),
      maxFeatures: 200,
    });

    executeQuery(wfs, xml, controller.signal)
      .then(({ features }) => {
        const ordered = [...features].sort((a, b) =>
          String(a.get(history.validFromProperty) ?? '').localeCompare(String(b.get(history.validFromProperty) ?? ''))
        );
        const rows: Version[] = ordered.map((f, i) => {
          const previous = i > 0 ? ordered[i - 1] : null;
          return {
            feature: f,
            from: String(f.get(history.validFromProperty) ?? ''),
            to: (f.get(history.validToProperty) as string | null) ?? null,
            changed: previous ? comparable.filter((p) => String(f.get(p) ?? '') !== String(previous.get(p) ?? '')) : [],
          };
        });
        rows.reverse(); // newest first
        setVersions(rows);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfs, history, layerName, feature, identity, comparable]);

  if (!feature) return null;

  return (
    <section className="history">
      <div className="history-header">
        <span>History</span>
        {identity && (
          <span className="history-key mono" dir="ltr">
            {identity.property.property}={String(identity.value)}
          </span>
        )}
      </div>

      {!identity && (
        <div className="history-empty">
          No identity column on this feature — looked for <span className="mono">{history.identityProperties.join(', ')}</span>
        </div>
      )}
      {loading && <div className="history-empty">Loading versions…</div>}
      {error && <div className="history-empty history-error">{error}</div>}
      {!loading && !error && identity && versions.length === 0 && <div className="history-empty">No versions found</div>}

      <ol className="timeline">
        {versions.map((v, i) => {
          const isCurrent = v.to === null;
          const isActive = activeIndex === i;
          return (
            <li
              key={`${v.from}-${i}`}
              className={['timeline-item', isCurrent ? 'is-current' : '', isActive ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => {
                const next = isActive ? null : i;
                setActiveIndex(next);
                onShowVersion(next === null ? null : v.feature);
              }}
            >
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-body">
                <div className="timeline-range mono" dir="ltr">
                  {formatInstant(v.from)} <span className="timeline-arrow">→</span> {v.to ? formatInstant(v.to) : 'now'}
                </div>
                <div className="timeline-meta">
                  <span className={`badge${isCurrent ? ' badge-current' : ''}`}>{isCurrent ? 'current' : `v${versions.length - i}`}</span>
                  <span className="timeline-span">{formatSpan(v.from, v.to)}</span>
                </div>
                {v.changed.length > 0 && (
                  <div className="timeline-changes">
                    {v.changed.slice(0, 6).map((p) => {
                      const known = properties.find((x) => x.property === p);
                      return (
                        <span key={p} className="chip" title={p}>
                          {known ? propertyLabel(known) : p}
                        </span>
                      );
                    })}
                    {v.changed.length > 6 && <span className="chip chip-more">+{v.changed.length - 6}</span>}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
