export interface Config {
  baseUrl: string;
  defaultProjects: string[];
  username?: string;
  password?: string;
  token?: string;
  timeoutMs: number;
  instructions?: string;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.OPENGROK_URL?.trim();
  if (!rawUrl) {
    throw new Error("OPENGROK_URL is required (e.g. https://opengrok.example.com)");
  }
  const timeoutMs = Number(env.OPENGROK_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OPENGROK_TIMEOUT_MS must be a positive number");
  }
  return {
    baseUrl: rawUrl.replace(/\/+$/, ""),
    defaultProjects: list(env.OPENGROK_DEFAULT_PROJECT),
    username: env.OPENGROK_USERNAME || undefined,
    password: env.OPENGROK_PASSWORD || undefined,
    token: env.OPENGROK_TOKEN || undefined,
    timeoutMs,
    instructions: env.OPENGROK_INSTRUCTIONS?.trim() || undefined,
  };
}
