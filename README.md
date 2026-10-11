# Geo Query UI

A React + TypeScript map client with a WMTS base map and a WFS attribute-query console.

The app talks to a layers metadata API:

- `GET {api.baseUrl}/layers` returns the available layers; their **aliases** populate the layer dropdown.
- `GET {api.baseUrl}/layers/{layerName}` returns the layer's properties; the property dropdown shows the **alias when present, otherwise the raw property name**. Geometry (`gml:*`) properties are excluded from querying.
- If a property has `possibleValues`, the value input becomes a dropdown of those values.
- Operators adapt to the `xsd` type: numbers and dates get `= ≠ > ≥ < ≤`, strings get `= ≠ LIKE`, enumerated properties get `= ≠`.
- Running a query POSTs an OGC `GetFeature` request (built with OpenLayers) to the configured WFS endpoint, draws the returned features on the map, zooms to them, and lists them in a clickable results table. The panel shows a live preview of the filter being built.
- A **bounding box** can constrain the query spatially — drag one out on the map or snap it to the current view. The attribute condition and the bbox are ANDed; either one is enough on its own.

## Configuration

`config/` is the only source of configuration, layered the way [node-config](https://github.com/node-config/node-config) does it:

```
config/default.json                     baseline for every environment
config/{NODE_ENV}.json                  development.json / production.json
config/local.json                       per-machine overrides (git-ignored)
config/custom-environment-variables.json  env var → config key mapping
```

Later layers win, and each may carry only the keys it changes — anything missing falls back to `config/default.json`, which is also compiled into the bundle as a safety net.

This is a static bundle, so there is no process to read `config/` at runtime: the resolved document is written into `index.html` as `window.__APP_CONFIG__`, which `src/config.ts` reads on startup. That happens twice, and the second time is the point:

- **vite** injects it when serving and when building (`scripts/app-config.mjs`, wired up in `vite.config.ts`).
- **the container entrypoint** injects it again on startup, from the environment the container actually runs in. That is what lets one image be configured per deployment — set `WFS_URL` in a ConfigMap, roll the pods, done. No rebuild, and no `config.json` to mount.

The result is validated (URL shapes, `ui.direction`, a reachable base map, …). At startup that is fatal — a misconfigured container exits instead of serving a broken page. At build time it is only a warning, since the build machine is not the deployment.

```bash
npm run config:print    # resolve and print, write nothing
```

### Environment variables

Every key can be set from the environment; the mapping lives in `config/custom-environment-variables.json`, and values are parsed per `__format` (`boolean`, `number`, `json`). A `.env` file at the repo root is picked up for local development.

| Variable | Config key | Meaning |
| --- | --- | --- |
| `API_BASE_URL` | `api.baseUrl` | Base URL of the layers metadata API |
| `WMTS_CAPABILITIES_URL` | `wmts.capabilitiesUrl` | WMTS `GetCapabilities` URL |
| `WMTS_LAYER` / `WMTS_MATRIX_SET` / `WMTS_STYLE` / `WMTS_FORMAT` | `wmts.*` | WMTS layer selection |
| `WMTS_OSM_FALLBACK` | `wmts.osmFallback` | Use OpenStreetMap when no WMTS is configured |
| `WFS_URL` | `wfs.url` | WFS endpoint receiving the `GetFeature` POST |
| `WFS_VERSION` / `WFS_SRS_NAME` | `wfs.*` | Request encoding and requested CRS |
| `WFS_FEATURE_NS` / `WFS_FEATURE_PREFIX` | `wfs.*` | Feature type namespace and prefix (your GeoServer workspace) |
| `WFS_GEOMETRY_NAME` / `WFS_MAX_FEATURES` | `wfs.*` | Geometry column, default result limit |
| `MAP_PROJECTION` / `MAP_ZOOM` | `map.*` | View projection and initial zoom |
| `MAP_CENTER` | `map.center` | JSON, e.g. `[3874500,3772800]` |
| `MAP_CUSTOM_PROJECTIONS` | `map.customProjections` | JSON, EPSG code → proj4 definition |
| `UI_TITLE` / `UI_DIRECTION` | `ui.*` | App title and layout direction |

The three URLs may be absolute (`https://host/path` — the target must send CORS headers) or same-origin (`/path`, when an ingress serves the app and the service together).

### Config keys

| Key | Meaning |
| --- | --- |
| `api.baseUrl` | Base URL of the layers metadata API (`/layers`, `/layers/{name}`) |
| `map.projection` | View projection (default `EPSG:4326`) |
| `map.center`, `map.zoom` | Initial view, in map projection units (defaults to the whole world; results zoom themselves) |
| `map.customProjections` | Optional map of EPSG code → proj4 definition, registered on startup |
| `wmts.capabilitiesUrl` | WMTS `GetCapabilities` URL. The source is derived from it |
| `wmts.layer` / `matrixSet` / `style` / `format` | WMTS layer selection (matrixSet/style/format optional) |
| `wmts.osmFallback` | Use OpenStreetMap when no WMTS is configured (dev convenience) |
| `wfs.url` | WFS endpoint receiving the `GetFeature` POST |
| `wfs.version` | WFS version for request encoding (default `1.1.0`) |
| `wfs.srsName` | CRS requested for returned geometry — should match `map.projection` |
| `wfs.featureNS` / `featurePrefix` | Feature type namespace and prefix (e.g. your GeoServer workspace) |
| `wfs.geometryName` | Geometry property name (default `geom`) |
| `wfs.maxFeatures` | Default result limit (editable in the UI) |
| `ui.title`, `ui.direction` | App title and layout direction (`ltr` / `rtl`) |

> CORS note: the layers API, the WFS, and the WMTS must be reachable from the browser. Serving them under the same origin (e.g. an ingress that routes `/api` and `/geoserver`) avoids CORS entirely.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build
```

Put your own endpoints in `config/local.json` — it overrides everything else and is git-ignored:

```json
{
  "api": { "baseUrl": "/api" },
  "wfs": { "url": "/geoserver/wfs", "featureNS": "myworkspace", "featurePrefix": "myworkspace" },
  "devProxy": {
    "/api": "https://layers-api.example.com",
    "/geoserver": "http://localhost:8080/geoserver"
  }
}
```

`devProxy` is read by `vite.config.ts` (dev only): each path prefix is forwarded to the upstream base URL by the dev server, so the browser stays same-origin and **CORS never applies**. Point `api.baseUrl` / `wfs.url` at the prefixes to use it, and restart `npm run dev` after changing the map. `devProxy` is stripped from the config handed to the app.

`featureNS` / `featurePrefix` must match your GeoServer workspace — `wfs?service=WFS&request=GetCapabilities` lists them as `xmlns:prefix="namespace-uri"`; a mismatch gets you *"Could not locate {ns}layer in catalog"*.

With the default config the map falls back to OSM, so the UI is usable before any WMTS is wired up.

## Docker

```bash
docker build -t geo-query-ui .
docker run -p 8080:8080 \
  -e API_BASE_URL=/api \
  -e WFS_URL=/geoserver/wfs \
  -e WFS_FEATURE_NS=myworkspace -e WFS_FEATURE_PREFIX=myworkspace \
  geo-query-ui
```

Or `docker compose up --build`. The entrypoint resolves `config/` plus the environment into the served `index.html` before nginx starts, so the same image serves any environment. nginx serves the SPA on port 8080, exposes `/healthz`, never caches `index.html` (it carries the config), and hard-caches hashed assets.

## Helm

The chart in `helm/geo-query-ui` renders everything under `env` into a ConfigMap of the variables from `config/custom-environment-variables.json`, and the pod reads it with `envFrom`. The entrypoint turns those into the page's config at startup, so a changed ConfigMap only takes effect once the pods roll — `resetOnConfigChange` (on by default) adds a checksum annotation that does exactly that.

`cloudProvider.flavor` picks the exposure: `openshift` renders a Route, `minikube` makes the Service a NodePort, anything else leaves the plain Service (turn on `ingress.enabled` for it). Registry, pull secret and flavor are also read from an umbrella chart's `global.cloudProvider`.

```bash
helm upgrade --install geo-query ./helm/geo-query-ui \
  --set image.repository=registry.example.com/geo-query-ui \
  --set image.tag=v1.0.0 \
  --set route.host=geo.example.com \
  -f my-values.yaml
```

```yaml
env:
  nodeEnv: production
  api:
    # a prefix, not a route: the app calls {baseUrl}/layers and
    # {baseUrl}/layers/{layerName}. The browser resolves a relative value
    # against the host serving the UI, so that host must also route /api.
    baseUrl: "/api"
  wmts:
    capabilitiesUrl: "https://geo.example.com/wmts?SERVICE=WMTS&REQUEST=GetCapabilities"
    layer: "ortho"
    osmFallback: false
  wfs:
    url: "https://geo.example.com/geoserver/wfs"
    featureNS: "http://mycompany.com/geo"
    featurePrefix: "geo"
```

Anything left at its default falls back to `config/default.json` in the image. To use a ConfigMap maintained elsewhere, set `existingConfigMap` to its name — it must carry the same variable names, and no ConfigMap is rendered.

The chart depends on `mclabels` from the shared infra registry, so `helm dependency update helm/geo-query-ui` is needed before a first install.

## Project structure

```
src/
  config.ts               config types, reads window.__APP_CONFIG__
  api/                    layers API client and response types
  map/                    OpenLayers map, WMTS source (capabilities or OSM fallback)
  query/                  operators model, WFS GetFeature builder, query panel
  components/             results table
helm/geo-query-ui/        Helm chart (deployment, service, route/ingress, config ConfigMap)
Dockerfile, nginx.conf    multi-stage image, SPA-aware nginx
```
