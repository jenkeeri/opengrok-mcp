# opengrok-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent search and read source code
indexed by an [OpenGrok](https://oracle.github.io/opengrok/) instance. Read-only, stdio transport.

Tested against OpenGrok 1.14. It uses the REST search API and the `/raw` file route, both of which
work anonymously on a default install.

## Tools

| Tool | Purpose |
|------|---------|
| `opengrok_search` | Search by `full` text, `def` (definitions), `symbol`, `path`, `hist` (commit messages) and `type`, with paging. |
| `opengrok_find_file` | Find files by name or path pattern. |
| `opengrok_get_file` | Read a file (line-numbered) by the path returned from search, with an optional line range. |
| `opengrok_list_projects` | List the project names on the instance. |

Searches are scoped to the configured default project(s); pass `projects` to pick others or
`all_projects: true` to search everything.

## Install

Requires Node.js 20+.

```bash
git clone https://github.com/jenkeeri/opengrok-mcp.git
cd opengrok-mcp
npm install && npm run build
```

## Configuration

All settings are environment variables, normally set in your MCP client's server entry:

| Variable | Required | Description |
|----------|:--------:|-------------|
| `OPENGROK_URL` | yes | Base URL, e.g. `https://opengrok.example.com` |
| `OPENGROK_DEFAULT_PROJECT` | no | Comma-separated default project(s). Empty means all projects. |
| `OPENGROK_INSTRUCTIONS` | no | Free text appended to the server instructions the agent sees. Use it to describe your project layout (what each project is, naming conventions). |
| `OPENGROK_TOKEN` | no | Bearer token, if the instance needs one. |
| `OPENGROK_USERNAME` / `OPENGROK_PASSWORD` | no | Basic auth, if the instance needs it. |
| `OPENGROK_TIMEOUT_MS` | no | Per-request timeout (default `30000`). |

Example MCP client entry:

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "node",
      "args": ["/path/to/opengrok-mcp/dist/index.js"],
      "env": {
        "OPENGROK_URL": "https://opengrok.example.com",
        "OPENGROK_DEFAULT_PROJECT": "myproject",
        "OPENGROK_INSTRUCTIONS": "Project 'myproject' is the main branch; 'myproject-1.2' is a release branch."
      }
    }
  }
}
```

## Notes

- Use the REST parameter names `projects`, `def`, `symbol` and `start`. The web UI names (`project`,
  `defs`, `refs`) are silently ignored by the API, which makes project filtering appear broken.
- `type` takes an OpenGrok analyzer name (`c`, `cxx`, `java`, `python`, ...); an unknown name
  returns zero results.
- `def` and `symbol` rely on OpenGrok's language-aware indexing; use `full` for file types it cannot parse.

## Development

```bash
npm test          # unit tests (synthetic fixtures, no network)
npm run typecheck
npm run build
```

## License

GPL-3.0, see [LICENSE](LICENSE).
