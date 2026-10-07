import { describe, expect, it } from "vitest";
import { OpenGrokClient, encodePath } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { cleanLine, formatFile, formatSearch } from "../src/format.js";
import { assertSafePath, resolveProjects } from "../src/tools.js";

const cfg = loadConfig({ OPENGROK_URL: "https://og.example.com/", OPENGROK_DEFAULT_PROJECT: "main, extra" });

function fakeFetch(body: string, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("config", () => {
  it("requires OPENGROK_URL", () => {
    expect(() => loadConfig({})).toThrow(/OPENGROK_URL/);
  });
  it("normalises url and splits default projects", () => {
    expect(cfg.baseUrl).toBe("https://og.example.com");
    expect(cfg.defaultProjects).toEqual(["main", "extra"]);
  });
});

describe("project resolution", () => {
  it("prefers explicit, then all, then default", () => {
    expect(resolveProjects(cfg, ["x"], true)).toEqual(["x"]);
    expect(resolveProjects(cfg, undefined, true)).toEqual([]);
    expect(resolveProjects(cfg)).toEqual(["main", "extra"]);
  });
});

describe("client", () => {
  it("sends the REST API parameter names OpenGrok actually honours", async () => {
    const f = fakeFetch('{"resultCount":0,"startDocument":0,"endDocument":-1,"results":{}}');
    await new OpenGrokClient(cfg, f.impl).search({
      full: "foo", def: "bar", projects: ["a", "b"], maxResults: 5, start: 10,
    });
    const url = new URL(f.calls[0]!);
    expect(url.pathname).toBe("/api/v1/search");
    expect(url.searchParams.get("def")).toBe("bar");
    expect(url.searchParams.getAll("projects")).toEqual(["a", "b"]);
    expect(url.searchParams.get("maxresults")).toBe("5");
    expect(url.searchParams.get("start")).toBe("10");
    expect(url.searchParams.has("startDocument")).toBe(false);
  });
  it("fetches files from /raw with encoded segments", async () => {
    const f = fakeFetch("x");
    await new OpenGrokClient(cfg, f.impl).getRaw("/p/my dir/a#b.c");
    expect(f.calls[0]).toBe("https://og.example.com/raw/p/my%20dir/a%23b.c");
    expect(encodePath("/a/b")).toBe("/a/b");
  });
  it("maps auth failures to an actionable error", async () => {
    const f = fakeFetch("", 401);
    await expect(new OpenGrokClient(cfg, f.impl).listProjects()).rejects.toThrow(/OPENGROK_TOKEN/);
  });
  it("sends a bearer token when configured", async () => {
    let seen: HeadersInit | undefined;
    const impl = (async (_u: string, init?: RequestInit) => {
      seen = init?.headers;
      return new Response("[]");
    }) as unknown as typeof fetch;
    const c = loadConfig({ OPENGROK_URL: "https://og.example.com", OPENGROK_TOKEN: "t0k" });
    await new OpenGrokClient(c, impl).listProjects();
    expect(seen).toEqual({ Authorization: "Bearer t0k" });
  });
});

describe("format", () => {
  it("strips highlights and decodes entities", () => {
    expect(cleanLine("a <b>&lt;x&gt;</b> &amp; &#1057; &#x41;")).toBe("a <x> & С A");
  });
  it("formats a page with a next-start hint", () => {
    const text = formatSearch(
      { resultCount: 3, startDocument: 0, endDocument: 0, results: { "/p/a.c": [{ line: "<b>foo</b>()", lineNumber: "7" }] } },
      0,
      "p",
    );
    expect(text).toContain("3 file(s) matched in p; showing 1-1");
    expect(text).toContain("  7: foo()");
    expect(text).toContain("start=1");
  });
  it("reports empty results", () => {
    expect(formatSearch({ resultCount: 0, startDocument: 0, endDocument: -1, results: {} }, 0, "p")).toBe("No results in p.");
  });
  it("slices a line range with numbering", () => {
    const text = formatFile("/p/a.c", "l1\nl2\nl3\nl4\n", 2, 3, 1000);
    expect(text).toBe("/p/a.c (lines 2-3 of 4)\n2: l2\n3: l3");
  });
  it("truncates large files with a hint", () => {
    expect(formatFile("/p/a.c", "x".repeat(500), undefined, undefined, 50)).toContain("[truncated at 50 characters");
  });
});

describe("path safety", () => {
  it("rejects relative paths and traversal", () => {
    expect(() => assertSafePath("p/a.c")).toThrow();
    expect(() => assertSafePath("/p/../etc")).toThrow();
    expect(() => assertSafePath("/p/a.c")).not.toThrow();
  });
});
