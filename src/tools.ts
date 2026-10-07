import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenGrokClient, OpenGrokError } from "./client.js";
import type { Config } from "./config.js";
import { formatFile, formatSearch, truncate } from "./format.js";

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
- full: full-text Lucene query. Supports wildcards (foo*), phrases ("a b"), AND/OR/NOT (uppercase), fuzzy (word~), regex (/re/).
- def: where a symbol is DEFINED. symbol: where a symbol is referenced or defined. Both need language-aware indexing, so they return nothing for file types OpenGrok cannot parse; fall back to full.
- path: restrict by file path (e.g. "src/net", "*.cpp").
- hist: search commit messages.
- type: OpenGrok analyzer name, e.g. c, cxx, java, python, sh, xml, json, yaml, plain. An unknown name yields zero results.
Default scope: ${defaults}. Results list files with matching lines (line numbers where available).`,
      inputSchema: {
        full: z.string().optional().describe("Full-text query."),
        def: z.string().optional().describe("Symbol whose definition to find."),
        symbol: z.string().optional().describe("Symbol to find references to."),
        path: z.string().optional().describe("Path filter."),
        hist: z.string().optional().describe("History/commit message query."),
        type: z.string().optional().describe("File type (analyzer name)."),
        ...projectFields,
        ...paging,
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
        const r = await client.search({
          full: a.full, def: a.def, symbol: a.symbol, path: a.path, hist: a.hist, type: a.type,
          projects, maxResults: a.max_results ?? 20, start,
        });
        return ok(truncate(formatSearch(r, start, scopeLabel(projects)), RESPONSE_LIMIT, "Narrow with path, type or project"));
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
Examples: "main.cpp" (name), "*.sql" (wildcard), "src/net" (directory), "/.*test.*\\.py/" (regex).
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
        const r = await client.search({
          path: a.path_pattern, type: a.type, projects, maxResults: a.max_results ?? 30, start,
        });
        const files = Object.keys(r.results);
        const scope = scopeLabel(projects);
        if (files.length === 0) {
          return ok(start > 0 ? `No more files (total ${r.resultCount} in ${scope}).` : `No files matching '${a.path_pattern}' in ${scope}.`);
        }
        const end = start + files.length;
        let text = `${r.resultCount} file(s) matching '${a.path_pattern}' in ${scope}; showing ${start + 1}-${end}:\n\n${files.join("\n")}`;
        if (end < r.resultCount) text += `\n\n${r.resultCount - end} more; call again with start=${end}.`;
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
