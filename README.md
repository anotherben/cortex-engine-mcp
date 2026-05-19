# Cortex Engine MCP

Code intelligence MCP server for local repositories. It builds a local SQLite-backed AST index, watches supported source files, and exposes MCP tools for outlines, symbol reads, search, references, git context, and lightweight project annotations.

The server runs locally. It does not require an API key and does not send indexed source code to an external service.

## Requirements

- Node.js 20 or newer
- A local git repository to index
- An MCP client that supports stdio servers

## Install

Clone the repository and install dependencies:

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
npm install
```

For a global command:

```bash
npm install -g git+https://github.com/<owner>/<repo>.git
cortex-engine /absolute/path/to/your/repo
```

For a local checkout, point your MCP client directly at the server:

```json
{
  "mcpServers": {
    "cortex-engine": {
      "command": "node",
      "args": [
        "/absolute/path/to/cortex-engine-mcp/src/server.js",
        "/absolute/path/to/your/repo"
      ]
    }
  }
}
```

If the command was installed globally, the MCP config can use the binary:

```json
{
  "mcpServers": {
    "cortex-engine": {
      "command": "cortex-engine",
      "args": ["/absolute/path/to/your/repo"]
    }
  }
}
```

## Configuration

Create `cortex.config.js` in the repository you want to index:

```js
module.exports = {
  dbPath: '.cortex/index.db',
  extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.md'],
  ignorePaths: ['dist', 'build', 'coverage'],
  usePolling: false,
  pollInterval: 100,
  tagRules: {},
};
```

If no config file exists, Cortex Engine uses sensible defaults and stores its index at `.cortex/index.db` inside the target repository.

## Tools

- `cortex_status`: index health and counts
- `cortex_reindex`: rebuild all or part of the index
- `cortex_tree`: indexed file tree
- `cortex_outline`: symbols in a file
- `cortex_read_symbol`: source for one symbol
- `cortex_read_symbols`: source for several symbols
- `cortex_read_range`: source by line range
- `cortex_context`: symbol plus imports and outline
- `cortex_find_symbol`: symbol search
- `cortex_find_text`: indexed text search
- `cortex_find_references`: identifier references
- `cortex_find_importers`: files that import a path
- `cortex_find_by_tag`: semantic tag search
- `cortex_git_status`: current git status
- `cortex_git_diff`: git diff
- `cortex_git_blame`: git blame for a file
- `cortex_git_log`: recent commits
- `cortex_git_hotspots`: frequently changed files
- `cortex_annotate`: store a local annotation
- `cortex_recall`: retrieve annotations
- `cortex_patterns`: retrieve directory-level patterns
- `cortex_lessons`: retrieve stored lessons
- `cortex_sync_knowledge`: export annotations to an Obsidian-compatible vault
- `cortex_list_repos`: list indexed repositories
- `cortex_add_repo`: add another repository at runtime
- `cortex_diagnostic`: run index diagnostics
- `cortex_telemetry`: local query telemetry

## Development

```bash
npm install
npm test
node bin/cortex.js --help
```

The generated `.cortex/` index, `node_modules/`, environment files, and coverage output are ignored by git.
