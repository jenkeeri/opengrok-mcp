import type { SearchResponse } from "./client.js";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Strip OpenGrok's highlight markup and decode HTML entities. */
export function cleanLine(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return NAMED[name.toLowerCase()] ?? m;
    });
}

export function truncate(text: string, limit: number, hint: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated at ${limit} characters. ${hint}]`;
}

export interface FormatSearchOptions {
  /** Max matching lines shown per file (default 10); the rest are summarised as a count. */
  maxLinesPerFile?: number;
  /** Collapse identical lines across files (commit-message results repeat each commit per file). */
  dedupeLines?: boolean;
}

export function formatSearch(
  r: SearchResponse,
  start: number,
  scope: string,
  { maxLinesPerFile = 10, dedupeLines = false }: FormatSearchOptions = {},
): string {
  const files = Object.entries(r.results);
  if (files.length === 0) {
    return start > 0
      ? `No more results (total ${r.resultCount} file(s) in ${scope}).`
      : `No results in ${scope}.`;
  }
  const shownEnd = start + files.length;
  const out = [`${r.resultCount} file(s) matched in ${scope}; showing ${start + 1}-${shownEnd}:`, ""];
  const seen = new Set<string>();
  for (const [path, hits] of files) {
    const lines: string[] = [];
    for (const h of hits) {
      const text = cleanLine(h.line).trim();
      if (!text || text === "...") continue;
      if (dedupeLines) {
        if (seen.has(text)) continue;
        seen.add(text);
      }
      lines.push(h.lineNumber ? `  ${h.lineNumber}: ${text}` : `  ${text}`);
    }
    if (dedupeLines && hits.length > 0 && lines.length === 0) continue;
    out.push(path, ...lines.slice(0, maxLinesPerFile));
    if (lines.length > maxLinesPerFile) {
      out.push(`  ... ${lines.length - maxLinesPerFile} more matching line(s) in this file (read it with opengrok_get_file)`);
    }
  }
  if (shownEnd < r.resultCount) {
    out.push("", `${r.resultCount - shownEnd} more file(s); call again with start=${shownEnd}.`);
  }
  return out.join("\n");
}

export function formatFile(
  path: string,
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
  limit: number,
): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const from = Math.max(startLine ?? 1, 1);
  const to = Math.min(endLine ?? lines.length, lines.length);
  if (from > lines.length) {
    return `${path} has only ${lines.length} line(s); start_line=${from} is past the end.`;
  }
  const width = String(to).length;
  const numbered = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)}: ${l}`);
  // Keep whole lines within the budget so the header can state the range actually returned.
  const budget = limit - (path.length + 64);
  let shown = 0;
  let used = 0;
  for (const l of numbered) {
    if (shown > 0 && used + l.length + 1 > budget) break;
    used += l.length + 1;
    shown++;
  }
  const last = from + shown - 1;
  const head = `${path} (lines ${from}-${last} of ${lines.length})`;
  const body = numbered.slice(0, shown).join("\n");
  if (body.length > budget) return truncate(`${head}\n${body}`, limit, "A single line exceeds the limit");
  if (shown === numbered.length) return `${head}\n${body}`;
  return `${head}\n${body}\n\n[truncated at line ${last}. Use start_line=${last + 1} to continue (file has ${lines.length} lines)]`;
}
