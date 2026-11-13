import { describe, expect, it } from "vitest";
import type { SearchResponse } from "../src/client.js";
import { formatSearch } from "../src/format.js";
import { collectPages, normalizePath } from "../src/pathquery.js";

describe("normalizePath", () => {
  it("passes plain and dotted names through unchanged", () => {
    expect(normalizePath("ebpp")).toEqual({ query: "ebpp" });
    expect(normalizePath("cs.bc.netio")).toEqual({ query: "cs.bc.netio" });
    expect(normalizePath("nioclient.cpp")).toEqual({ query: "nioclient.cpp" });
    expect(normalizePath("/cs.bc.netio")).toEqual({ query: "/cs.bc.netio" });
  });
  it("passes regex and trailing-wildcard names without dots through unchanged", () => {
    expect(normalizePath("/ebpp.*/")).toEqual({ query: "/ebpp.*/" });
    expect(normalizePath("nioclient*")).toEqual({ query: "nioclient*" });
    expect(normalizePath("*nioclient*")).toEqual({ query: "*nioclient*" });
  });
  it("turns dir/* and dir/** into the plain directory", () => {
    expect(normalizePath("cs.bc.netio/*")).toEqual({ query: "cs.bc.netio" });
    expect(normalizePath("cs.bc.netio/**")).toEqual({ query: "cs.bc.netio" });
    expect(normalizePath("cs.pkg.Level1_EnterpriseServices/cs.bc.netio/*")).toEqual({
      query: "cs.pkg.Level1_EnterpriseServices/cs.bc.netio",
    });
  });
  it("maps extension wildcards to the extension token with a name check", () => {
    const n = normalizePath("*.cpp");
    expect(n.query).toBe("cpp");
    expect(n.keep!("/CS/cs.bc.netio/nioclient.cpp")).toBe(true);
    expect(n.keep!("/CS/cpp/readme.txt")).toBe(false);
    expect(n.keep!("/CS/cs.bc.netio/nioclient.cpp.bak")).toBe(false);
  });
  it("keeps only the requested extension prefix for *.h*", () => {
    const n = normalizePath("*.h*");
    expect(n.query).toBe("h*");
    expect(n.keep!("/CS/x/ESock.h")).toBe(true);
    expect(n.keep!("/CS/x/ESock.hpp")).toBe(true);
    expect(n.keep!("/CS/x/page.html")).toBe(true);
    expect(n.keep!("/CS/x/page.cpp")).toBe(false);
  });
  it("maps name wildcards with dots to AND-ed tokens", () => {
    expect(normalizePath("dtv.*").query).toBe("dtv");
    expect(normalizePath("cs.bc.x_queue*").query).toBe("cs AND bc AND x_queue*");
    expect(normalizePath("cs.bc.netio/nioclient*").query).toBe("cs AND bc AND netio AND nioclient*");
  });
  it("checks wildcard+dot names against the path components in order", () => {
    const n = normalizePath("cs.bc.netio/nioclient*");
    expect(n.keep!("/CS/cs.pkg.L1/cs.bc.netio/nioclient_http.cpp")).toBe(true);
    expect(n.keep!("/CS/cs.pkg.L1/cs.bc.other/nioclient_http.cpp")).toBe(false);
    expect(n.keep!("/CS/cs.bc.netio/x/nioclient_http.cpp")).toBe(false);
  });
  it("escapes Lucene operators in tokens", () => {
    expect(normalizePath("my-mod.c*").query).toBe("my\\-mod AND c*");
  });
  it("keeps values with nothing to match on as they are", () => {
    expect(normalizePath("*.*")).toEqual({ query: "*.*" });
  });
});

function page(paths: string[], resultCount: number): SearchResponse {
  return {
    resultCount,
    startDocument: 0,
    endDocument: 0,
    results: Object.fromEntries(paths.map((p) => [p, [{ line: "x", lineNumber: "1" }]])),
  };
}

/** Serves `all` as pages honouring start and maxResults, like OpenGrok does. */
function server(all: string[]) {
  const starts: number[] = [];
  const fetchPage = async (start: number, maxResults: number) => {
    starts.push(start);
    return page(all.slice(start, start + maxResults), all.length);
  };
  return { fetchPage, starts };
}

describe("collectPages", () => {
  it("makes one request when there is no exact check", async () => {
    const s = server(["/a/1.c", "/a/2.c", "/a/3.c"]);
    const c = await collectPages(s.fetchPage, { start: 0, maxResults: 2 });
    expect(s.starts).toEqual([0]);
    expect(Object.keys(c.files)).toEqual(["/a/1.c", "/a/2.c"]);
    expect(c.consumed).toBe(2);
    expect(c.resultCount).toBe(3);
  });
  it("pages on until enough files pass the check", async () => {
    const all = ["/x/a.h", "/x/b.c", "/x/c.c", "/x/d.h", "/x/e.c", "/x/f.h"];
    const s = server(all);
    const c = await collectPages(s.fetchPage, { start: 0, maxResults: 2, keep: (p) => p.endsWith(".h") });
    expect(Object.keys(c.files)).toEqual(["/x/a.h", "/x/d.h"]);
    expect(c.consumed).toBe(4);
    expect(s.starts).toEqual([0, 2]);
  });
  it("stops at the file that fills the page so the next start is exact", async () => {
    const all = ["/x/a.h", "/x/b.h", "/x/c.c", "/x/d.h"];
    const s = server(all);
    const c = await collectPages(s.fetchPage, { start: 0, maxResults: 1, keep: (p) => p.endsWith(".h") });
    expect(Object.keys(c.files)).toEqual(["/x/a.h"]);
    expect(c.consumed).toBe(1);
  });
  it("continues from start when resumed", async () => {
    const all = ["/x/a.h", "/x/b.c", "/x/c.h"];
    const s = server(all);
    const c = await collectPages(s.fetchPage, { start: 1, maxResults: 5, keep: (p) => p.endsWith(".h") });
    expect(Object.keys(c.files)).toEqual(["/x/c.h"]);
    expect(s.starts[0]).toBe(1);
    expect(c.consumed).toBe(2);
  });
});

describe("formatSearch with consumed", () => {
  it("advances the next-page hint by the raw files consumed", () => {
    const text = formatSearch(
      { resultCount: 50, startDocument: 0, endDocument: 0, results: { "/x/a.h": [{ line: "y", lineNumber: "1" }] } },
      0,
      "CS",
      { consumed: 4 },
    );
    expect(text).toContain("showing 1-4");
    expect(text).toContain("start=4");
  });
});
