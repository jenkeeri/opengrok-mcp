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

export function formatSearch(r: SearchResponse, start: number, scope: string): string {
  const files = Object.entries(r.results);
  if (files.length === 0) {
    return start > 0
      ? `No more results (total ${r.resultCount} file(s) in ${scope}).`
      : `No results in ${scope}.`;
  }
  const shownEnd = start + files.length;
  const out = [`${r.resultCount} file(s) matched in ${scope}; showing ${start + 1}-${shownEnd}:`, ""];
  for (const [path, hits] of files) {
    out.push(path);
    for (const h of hits) {
      const text = cleanLine(h.line).trim();
      if (!text || text === "...") continue;
      out.push(h.lineNumber ? `  ${h.lineNumber}: ${text}` : `  ${text}`);
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
  const body = lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width)}: ${l}`)
    .join("\n");
  const head = `${path} (lines ${from}-${to} of ${lines.length})`;
  return truncate(`${head}\n${body}`, limit, `Use start_line/end_line to read further (file has ${lines.length} lines)`);
}
