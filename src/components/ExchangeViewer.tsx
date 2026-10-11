import { Suspense, lazy, useMemo, useState } from "react";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import { featuresToGeoJson } from "../query/geojson";
import { prettyXml } from "../query/wfs";
import CopyButton from "./CopyButton";
import JsonTree from "./JsonTree";

// Monaco is heavy — fetched the first time a response is actually shown.
const CodeEditor = lazy(() => import("./CodeEditor"));

interface Props {
  /** Only used to know a query has run — the request itself lives in the panel above. */
  requestXml: string | null;
  responseXml: string | null;
  features: Feature<Geometry>[];
  /** Projection the features are in — needed to write WGS84 GeoJSON. */
  featureProjection: string;
}

type Tab = "response" | "geojson";

const TABS: { id: Tab; label: string }[] = [
  { id: "response", label: "XML" },
  { id: "geojson", label: "GeoJSON" }
];

export default function ExchangeViewer({
  requestXml,
  responseXml,
  features,
  featureProjection
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("response");

  const body = useMemo(() => {
    try {
      switch (tab) {
        case "response":
          return responseXml ? prettyXml(responseXml) : null;
        case "geojson":
          return features.length > 0 ? featuresToGeoJson(features, featureProjection) : null;
      }
    } catch (e) {
      return `Could not render: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [tab, responseXml, features, featureProjection]);

  if (!requestXml && !responseXml) return null;

  return (
    <section className="exchange">
      <button className="exchange-toggle" onClick={() => setOpen((o) => !o)}>
        <span>{open ? "▾" : "▸"} WFS response</span>
        {responseXml && <span className="mono exchange-size">{responseXml.length} B</span>}
      </button>

      {open && (
        <>
          <div className="exchange-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={t.id === tab ? "exchange-tab exchange-tab-active" : "exchange-tab"}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === "geojson" ? (
            // the collapsible tree, so a big FeatureCollection can be folded away
            <JsonTree code={body ?? "—"} className="exchange-body" />
          ) : (
            <Suspense
              fallback={
                <div className="xml-editor code-editor-response xml-editor-loading">
                  Loading editor…
                </div>
              }
            >
              <div className="code-block">
                <CodeEditor value={body ?? ""} language="xml" className="code-editor-response" />
                {body && <CopyButton text={body} />}
              </div>
            </Suspense>
          )}
        </>
      )}
    </section>
  );
}
