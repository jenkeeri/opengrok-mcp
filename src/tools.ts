import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenGrokClient, OpenGrokError } from "./client.js";
import type { Config } from "./config.js";
import { formatFile, formatSearch, truncate } from "./format.js";
import { collectPages, normalizePath } from "./pathquery.js";

const RESPONSE_LIMIT = 30000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

export const BASE_INSTRUCTIONS = `Search and read source code indexed by an OpenGrok instance.
Workflow: opengrok_search or opengrok_find_file to locate code, then opengrok_get_file with a path exactly as returned (it starts with "/<project>/"). Call opengrok_list_projects to see valid project names.
Narrow broad searches with path, type or project before paging.`;

/** Resolve which projects to search: explicit > all > configured default > everything. */
export function resolveProjects(cfg: Config, projects?: string[], allProjects?: boolean): string[] {
  if (projects?.length) return projects;
  if (allProjects) return [];
  return cfg.defaultProjects;
}

const scopeLabel = (projects: string[]) => (projects.length ? projects.join(", ") : "all projects");

export function assertSafePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new OpenGrokError(`file_path must start with "/" (use a path exactly as returned by search), got "${path}".`);
  }
  if (path.split("/").includes("..")) {
    throw new OpenGrokError(`file_path must not contain ".." segments: "${path}".`);
  }
}

export function registerTools(server: McpServer, client: OpenGrokClient, cfg: Config): void {
  const defaults = cfg.defaultProjects.length ? cfg.defaultProjects.join(", ") : "none (all projects)";

  const projectFields = {
    projects: z.array(z.string()).optional().describe(
      `Projects to search (default: ${defaults}). Names from opengrok_list_projects.`,
    ),
    all_projects: z.boolean().optional().describe("Search every project instead of the default. Ignored if projects is set."),
  };
  const paging = {
    max_results: z.number().int().min(1).max(100).optional().describe("Files per page (default 20, max 100)."),
    start: z.number().int().min(0).optional().describe("Offset of the first file to return (default 0); use the value a previous page suggested."),
  };

  server.registerTool(
    "opengrok_search",
    {
      title: "Search OpenGrok",
      description: `Search source code. Provide at least one of full, def, symbol, path, hist; fields combine with AND.
- full: full-text Lucene query. Supports wildcards (foo*), phrases ("a b"), AND/OR/NOT (uppercase), fuzzy (word~), regex (/re/). Several bare terms or phrases are OR-ed, not AND-ed: write "a" AND "b" to require both. Matching is token-based, so punctuation-heavy phrases (e.g. containing :: or *) can miss; search a single identifier and use path to narrow instead. Returned lines are the indexer's best snippets and may not contain every term.
- def: where a symbol is DEFINED (token match, so def:Compose also hits Foo::Compose members; narrow with path). symbol: where a symbol is referenced or defined. Both need language-aware indexing, so they return nothing for file types OpenGrok cannot parse; fall back to full.
- path: restrict by file path, matched per path component (a name matches a component, not a prefix of the whole path). Works: plain names ("ebpp"), dotted names ("cs.bc.netio", "nioclient.cpp"), dir paths ("cs.bc.netio/nioclient"), trailing wildcards on a name ("nioclient*", "cs.bc.x_queue*"), leading/infix wildcards ("*nioclient*"), extension wildcards ("*.cpp", "*.h*", "dtv.*"), "dir/*" and "dir/**" (everything under dir), and regex /re/ for one component ("/ebpp.*/"; a regex cannot span "/" or match dots). For a wildcard with a dot the returned count is OpenGrok's raw hit count, and only files whose path component matches the pattern are listed. If a search with path returns nothing, retry without path to see which part failed.
- hist: search commit messages. "CSDEV" is a fuzzy word match; a bare ticket number (e.g. 53291) is exact. Commits are de-duplicated across files; only messages are returned, no diffs.
- type: OpenGrok analyzer name, e.g. c, cxx, java, python, sh, xml, json, yaml. An unknown name (no tool lists them) yields zero results.
Default scope: ${defaults}. Results list files with matching lines (line numbers where available), at most max_lines_per_file per file.`,
      inputSchema: {
        full: z.string().optional().describe("Full-text query."),
        def: z.string().optional().describe("Symbol whose definition to find."),
        symbol: z.string().optional().describe("Symbol to find references to."),
        path: z.string().optional().describe('Path filter per component: name, dotted name, wildcard ("nioclient*", "*.cpp", "dtv.*", "cs.bc.netio/*"), or regex "/re/". See the description.'),
        hist: z.string().optional().describe("History/commit message query."),
        type: z.string().optional().describe("File type (analyzer name)."),
        ...projectFields,
        ...paging,
        max_lines_per_file: z.number().int().min(1).max(200).optional().describe("Matching lines shown per file (default 10); extra lines are summarised as a count."),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if (!a.full && !a.def && !a.symbol && !a.path && !a.hist) {
          return fail("provide at least one of: full, def, symbol, path, hist.");
        }
        const projects = resolveProjects(cfg, a.projects, a.all_projects);
        const start = a.start ?? 0;
        const pq = a.path ? normalizePath(a.path) : undefined;
        const c = await collectPages(
          (s, n) => client.search({
            full: a.full, def: a.def, symbol: a.symbol, path: pq?.query, hist: a.hist, type: a.type,
            projects, maxResults: n, start: s,
          }),
          { start, maxResults: a.max_results ?? 20, keep: pq?.keep },
        );
        const r = { resultCount: c.resultCount, startDocument: start, endDocument: start + c.consumed - 1, results: c.files };
        let text: string;
        if (pq?.keep && c.consumed > 0 && Object.keys(c.files).length === 0) {
          text = `None of the ${c.consumed} file(s) checked (${c.resultCount} OpenGrok hits) match '${a.path}'.`;
          if (start + c.consumed < c.resultCount) text += ` Call again with start=${start + c.consumed}.`;
        } else {
          text = formatSearch(r, start, scopeLabel(projects), {
            maxLinesPerFile: a.max_lines_per_file,
            dedupeLines: Boolean(a.hist) && !a.full && !a.def && !a.symbol,
            consumed: c.consumed,
          });
          if (pq?.keep) {
            text = `${Object.keys(c.files).length} of ${c.consumed} checked file(s) match '${a.path}' (the count above is OpenGrok's).\n${text}`;
          }
        }
        if (c.resultCount === 0 && start === 0 && a.path) {
          text += ` The path filter '${a.path}' may be the cause (it matches per path component); retry without it.`;
        }
        return ok(truncate(text, RESPONSE_LIMIT, "Narrow with path, type or project, or lower max_lines_per_file"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "opengrok_find_file",
    {
      title: "Find files in OpenGrok",
      description: `Find files by path or file name. Returns file paths only.
Examples: "main.cpp" (name), "*.sql" (extension wildcard), "dtv.*" (name wildcard), "nioclient*" (prefix), "cs.bc.netio/*.cpp" (name under a directory), "/test.*/" (regex).
Matching is per path component: "main.cpp" matches a file or directory named exactly that, and a plain directory like "src/net" also returns docs and images under it, so add type or a file-name wildcard. A regex must match one component and cannot span "/" or match dots.
For a wildcard containing a dot, the count is OpenGrok's raw hit count; only names matching the pattern are listed, and a page may list fewer files than it checked.
Default scope: ${defaults}.`,
      inputSchema: {
        path_pattern: z.string().min(1).describe("Path or name pattern."),
        type: z.string().optional().describe("File type (analyzer name), as for opengrok_search."),
        ...projectFields,
        max_results: z.number().int().min(1).max(100).optional().describe("Files per page (default 30, max 100)."),
        start: paging.start,
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const projects = resolveProjects(cfg, a.projects, a.all_projects);
        const start = a.start ?? 0;
        const pq = normalizePath(a.path_pattern);
        const c = await collectPages(
          (s, n) => client.search({ path: pq.query, type: a.type, projects, maxResults: n, start: s }),
          { start, maxResults: a.max_results ?? 30, keep: pq.keep },
        );
        const files = Object.keys(c.files);
        const scope = scopeLabel(projects);
        if (c.consumed === 0) {
          return ok(start > 0 ? `No more files (total ${c.resultCount} in ${scope}).` : `No files matching '${a.path_pattern}' in ${scope}.`);
        }
        const end = start + c.consumed;
        if (files.length === 0) {
          const next = end < c.resultCount ? ` Call again with start=${end}.` : "";
          return ok(`None of the ${c.consumed} file(s) checked (${c.resultCount} OpenGrok hits) match '${a.path_pattern}'.${next}`);
        }
        let text = `${c.resultCount} file(s) matching '${a.path_pattern}' in ${scope}; checked ${start + 1}-${end}:\n\n${files.join("\n")}`;
        if (end < c.resultCount) text += `\n\n${c.resultCount - end} more; call again with start=${end}.`;
        return ok(truncate(text, RESPONSE_LIMIT, "Narrow the pattern or use type/project"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "opengrok_get_file",
    {
      title: "Read file from OpenGrok",
      description: `Read a file's content (line-numbered) by the full path returned from search, e.g. "/<project>/dir/file.c".
Use start_line/end_line for large files; output is cut at ${RESPONSE_LIMIT} characters.`,
      inputSchema: {
        file_path: z.string().min(1).describe('Full path as returned by search, starting with "/<project>/".'),
        start_line: z.number().int().min(1).optional().describe("First line (1-based, inclusive)."),
        end_line: z.number().int().min(1).optional().describe("Last line (1-based, inclusive)."),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        assertSafePath(a.file_path);
        const content = await client.getRaw(a.file_path);
        return ok(formatFile(a.file_path, content, a.start_line, a.end_line, RESPONSE_LIMIT));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "opengrok_list_projects",
    {
      title: "List OpenGrok projects",
      description: "List the project names available on the OpenGrok instance (valid values for the projects argument).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const projects = await client.listProjects();
        return ok(`${projects.length} project(s):\n${projects.join("\n")}`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
