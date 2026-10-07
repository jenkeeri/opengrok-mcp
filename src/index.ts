#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenGrokClient } from "./client.js";
import { loadConfig } from "./config.js";
import { BASE_INSTRUCTIONS, registerTools } from "./tools.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const instructions = cfg.instructions ? `${BASE_INSTRUCTIONS}\n\n${cfg.instructions}` : BASE_INSTRUCTIONS;
  const server = new McpServer({ name: "opengrok-mcp", version: "0.1.0" }, { instructions });
  registerTools(server, new OpenGrokClient(cfg), cfg);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`opengrok-mcp: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
