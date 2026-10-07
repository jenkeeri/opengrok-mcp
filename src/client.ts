import type { Config } from "./config.js";

export interface SearchHit {
  line: string;
  lineNumber: string;
}

export interface SearchResponse {
  resultCount: number;
  startDocument: number;
  endDocument: number;
  results: Record<string, SearchHit[]>;
}

export interface SearchParams {
  full?: string;
  def?: string;
  symbol?: string;
  path?: string;
  hist?: string;
  type?: string;
  projects?: string[];
  maxResults: number;
  start: number;
}

export class OpenGrokError extends Error {}

type Fetch = typeof fetch;

/** Thin wrapper over the OpenGrok REST API and the /raw file route. */
export class OpenGrokClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async search(p: SearchParams): Promise<SearchResponse> {
    const qs = new URLSearchParams();
    for (const key of ["full", "def", "symbol", "path", "hist", "type"] as const) {
      const v = p[key];
      if (v) qs.append(key, v);
    }
    for (const project of p.projects ?? []) qs.append("projects", project);
    qs.append("maxresults", String(p.maxResults));
    qs.append("start", String(p.start));
    const data = await this.get(`/api/v1/search?${qs}`);
    return JSON.parse(data) as SearchResponse;
  }

  async listProjects(): Promise<string[]> {
    return JSON.parse(await this.get("/api/v1/projects")) as string[];
  }

  /** Raw file content; `path` is as returned by search, e.g. "/proj/dir/file.c". */
  async getRaw(path: string): Promise<string> {
    return this.get(`/raw${encodePath(path)}`);
  }

  private headers(): Record<string, string> {
    const { token, username, password } = this.config;
    if (token) return { Authorization: `Bearer ${token}` };
    if (username && password) {
      return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
    }
    return {};
  }

  private async get(pathAndQuery: string): Promise<string> {
    const url = `${this.config.baseUrl}${pathAndQuery}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") {
        throw new OpenGrokError(`Request timed out after ${this.config.timeoutMs}ms (${this.config.baseUrl}). Is the network/VPN up?`);
      }
      throw new OpenGrokError(`Cannot reach ${this.config.baseUrl}: ${e.message}. Is the network/VPN up?`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OpenGrokError(`OpenGrok returned ${res.status}: authentication required. Set OPENGROK_TOKEN or OPENGROK_USERNAME/OPENGROK_PASSWORD.`);
    }
    if (res.status === 404) {
      throw new OpenGrokError("OpenGrok returned 404: not found (check the file path or project name).");
    }
    if (!res.ok) {
      throw new OpenGrokError(`OpenGrok returned HTTP ${res.status}.`);
    }
    return res.text();
  }
}

/** Encode each path segment, keeping "/" separators. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
