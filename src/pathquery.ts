import type { SearchHit, SearchResponse } from "./client.js";

/**
 * OpenGrok's path field is tokenised at "/" and "." (and matched per token), so a wildcard
 * inside a dotted value ("*.cpp", "dtv.*", "cs.bc.x_queue*") never matches a single token.
 * Such values are rewritten to one AND-ed term per token, and the returned files are then
 * checked against the full glob per path component, so the result is exact.
 */
export interface PathQuery {
  /** Value sent to OpenGrok's path field. */
  query: string;
  /** Exact check on returned file paths; absent when OpenGrok's own match is already exact. */
  keep?: (path: string) => boolean;
}

const WILDCARD = /[*?]/;
const ONLY_WILDCARDS = /^[*?]+$/;
const LUCENE_SPECIAL = /[+\-!(){}[\]^"~:&|\\]/g;

const escapeTerm = (token: string) => token.replace(LUCENE_SPECIAL, "\\$&");

function globToRegExp(glob: string): RegExp {
  const body = [...glob]
    .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

export function normalizePath(value: string): PathQuery {
  const v = value.trim();
  // Regex form /.../ and plain values (with or without dots) already work as sent.
  if (v.length > 2 && v.startsWith("/") && v.endsWith("/")) return { query: v };
  if (!WILDCARD.test(v)) return { query: v };

  // "dir/*" and "dir/**" mean everything under dir, which a plain dir query already returns.
  const dir = v.replace(/(\/\*\*?)+$/, "");
  if (dir && !WILDCARD.test(dir)) return { query: dir };

  // Wildcards without a dot are matched by OpenGrok as single-token terms ("nioclient*", "*name*").
  if (!v.includes(".")) return { query: v };

  const segs = v.split("/").filter(Boolean);
  const tokens = segs
    .flatMap((s) => s.split("."))
    .filter((t) => t && !ONLY_WILDCARDS.test(t));
  if (tokens.length === 0) return { query: v };

  const res = segs.map(globToRegExp);
  return {
    query: tokens.map(escapeTerm).join(" AND "),
    keep: (path) => {
      const comps = path.split("/").filter(Boolean);
      for (let i = 0; i + res.length <= comps.length; i++) {
        if (res.every((re, j) => re.test(comps[i + j]!))) return true;
      }
      return false;
    },
  };
}

export interface CollectedPages {
  /** Files kept after the exact check (all raw files when there is no check). */
  files: Record<string, SearchHit[]>;
  /** Raw files consumed from OpenGrok; the next page starts at start + consumed. */
  consumed: number;
  resultCount: number;
}

/**
 * Fetch raw result pages until `maxResults` files pass `keep` (or the results run out).
 * Without `keep` this is one request, exactly as before.
 */
export async function collectPages(
  fetchPage: (start: number, maxResults: number) => Promise<SearchResponse>,
  opts: { start: number; maxResults: number; keep?: (path: string) => boolean; maxPages?: number },
): Promise<CollectedPages> {
  const { start, maxResults, keep, maxPages = 5 } = opts;
  const files: Record<string, SearchHit[]> = {};
  let consumed = 0;
  let kept = 0;
  let resultCount = 0;
  const pages = keep ? maxPages : 1;
  for (let page = 0; page < pages; page++) {
    const r = await fetchPage(start + consumed, maxResults);
    resultCount = r.resultCount;
    const paths = Object.keys(r.results);
    if (paths.length === 0) break;
    for (const p of paths) {
      consumed++;
      if (!keep || keep(p)) {
        files[p] = r.results[p]!;
        kept++;
      }
      if (kept >= maxResults) break;
    }
    if (kept >= maxResults || start + consumed >= resultCount) break;
  }
  return { files, consumed, resultCount };
}
