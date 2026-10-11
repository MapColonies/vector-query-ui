import { describe, expect, it } from "vitest";
import { prettyXml, toCurlCommand } from "../src/query/wfs";
import { credentialHeaders } from "../src/config";

const xml = `<wfs:GetFeature xmlns:wfs="http://www.opengis.net/wfs">\n  <wfs:Query typeName="core:buildings"/>\n</wfs:GetFeature>`;

describe("toCurlCommand", () => {
  const cfg = { url: "https://example.com/geoserver/wfs", apiKey: "k3y", apiKeyHeader: "x-api-key" };

  it("posts to the configured url", () => {
    expect(toCurlCommand(cfg as never, xml)).toContain("curl -X POST 'https://example.com/geoserver/wfs'");
  });

  it("sends the key header the app sends", () => {
    expect(toCurlCommand(cfg as never, xml)).toContain("-H 'x-api-key: k3y'");
  });

  it("inlines the body on one line so curl importers can parse it", () => {
    const curl = toCurlCommand(cfg as never, xml);
    const body = curl.split("\n").find((l) => l.includes("--data-raw"));
    expect(body).toBeDefined();
    expect(curl).not.toContain("<<");
    expect(body).toContain("<wfs:Query");
  });

  it("escapes single quotes in the body", () => {
    expect(toCurlCommand(cfg as never, "<a b='c'/>")).toContain("'\\''");
  });

  it("resolves a relative url against the page origin", () => {
    expect(toCurlCommand({ url: "/geoserver/wfs" } as never, xml)).toMatch(/curl -X POST 'http:\/\/[^']+\/geoserver\/wfs'/);
  });
});

describe("prettyXml", () => {
  it("indents nested elements", () => {
    const out = prettyXml("<a><b><c/></b></a>");
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out).toMatch(/\n\s+<b>/);
  });

  it("returns invalid xml unchanged", () => {
    expect(prettyXml("<not closed")).toBe("<not closed");
  });
});

describe("credentialHeaders", () => {
  it("is empty without a key", () => {
    expect(credentialHeaders({})).toEqual({});
  });

  it("defaults the header name to x-api-key", () => {
    expect(credentialHeaders({ apiKey: "k" })).toEqual({ "x-api-key": "k" });
  });

  it("honours a custom header name", () => {
    expect(credentialHeaders({ apiKey: "k", apiKeyHeader: "Authorization" })).toEqual({ Authorization: "k" });
  });
});
