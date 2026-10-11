/**
 * Discovers raster products from a MapColonies CSW catalog.
 *
 * Each record carries its own WMTS capabilities URL — there is no single
 * document listing every product — so the catalog is how the base map finds
 * anything to show. Mirrors the request and record shape used by
 * MapColonies/geojson-viewer.
 */

export interface CswRecord {
  /** productId — stable, and what `wmts.productIds` matches against. */
  id: string;
  /** productName, for the picker. */
  title: string;
  capabilitiesUrl: string;
  /** The layer identifier inside that capabilities document. */
  layerId: string;
}

const MAX_RECORDS = 100;

const getRecordsBody = (startPosition: number) => `<?xml version="1.0" encoding="UTF-8"?>
<csw:GetRecords xmlns:csw="http://www.opengis.net/cat/csw/2.0.2" service="CSW" version="2.0.2"
  maxRecords="${MAX_RECORDS}" startPosition="${startPosition}"
  outputSchema="http://schema.mapcolonies.com/raster" xmlns:mc="http://schema.mapcolonies.com/raster">
  <csw:Query typeNames="mc:MCRasterRecord">
    <csw:ElementSetName>full</csw:ElementSetName>
    <csw:Constraint version="1.1.0">
      <Filter xmlns="http://www.opengis.net/ogc">
        <PropertyIsEqualTo>
          <PropertyName>mc:type</PropertyName>
          <Literal>RECORD_RASTER</Literal>
        </PropertyIsEqualTo>
      </Filter>
    </csw:Constraint>
  </csw:Query>
</csw:GetRecords>`;

/** Namespaced or not, depending on how the catalog serializes. */
function firstText(record: Element, names: string[]): string {
  for (const name of names) {
    const value = record.getElementsByTagName(name).item(0)?.textContent.trim();
    if (value) return value;
  }
  return '';
}

function elements(record: Element, names: string[]): Element[] {
  for (const name of names) {
    const nodes = Array.from(record.getElementsByTagName(name));
    if (nodes.length > 0) return nodes;
  }
  return [];
}

function parseRecords(doc: Document): CswRecord[] {
  const nodes = elements(doc.documentElement, ['mc:MCRasterRecord', 'MCRasterRecord']);
  return nodes.flatMap((record) => {
    const id = firstText(record, ['mc:productId', 'productId']);
    if (!id) return [];
    const links = elements(record, ['mc:links', 'links']);
    const wmtsLink = links.find((l) => l.getAttribute('scheme') === 'WMTS') ?? links.find((l) => l.getAttribute('scheme') === 'WMTS_KVP');
    const capabilitiesUrl = wmtsLink?.textContent.trim().replace(/^['"]+|['"]+$/g, '') ?? '';
    if (!capabilitiesUrl) return [];
    return [
      {
        id,
        title: firstText(record, ['mc:productName', 'productName']) || id,
        capabilitiesUrl,
        layerId: wmtsLink?.getAttribute('name') || id,
      },
    ];
  });
}

export async function fetchCswRecords(cswUrl: string, signal?: AbortSignal): Promise<CswRecord[]> {
  const res = await fetch(cswUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: getRecordsBody(1),
    signal,
  });
  if (!res.ok) throw new Error(`CSW GetRecords failed (HTTP ${res.status})`);

  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(`${cswUrl} did not return a CSW document`);
  }

  const exception = doc.querySelector('ExceptionText, ServiceException')?.textContent.trim();
  if (exception) throw new Error(`CSW: ${exception}`);

  // One page is plenty for finding the configured base maps; a deployment
  // whose products sit beyond MAX_RECORDS should name a smaller catalog.
  return parseRecords(doc);
}
