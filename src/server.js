const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const IndexEngine = require('./index');
const MultiRepoEngine = require('./multirepo');
const GitIntegration = require('./git');
const { registerFileTools } = require('./tools/file-tools');
const { registerSearchTools } = require('./tools/search-tools');
const { registerGitTools } = require('./tools/git-tools');
const { registerAdminTools } = require('./tools/admin-tools');
const { registerKnowledgeTools } = require('./tools/knowledge-tools');
const Knowledge = require('./knowledge');
const Fleet = require('./fleet');
const { registerFleetTools } = require('./tools/fleet-tools');
const { Telemetry, performance } = require('./telemetry');

function resolveConfig(projectRoot, config = {}) {
  const resolved = {
    dbPath: '.cortex/index.db',
    ...config,
  };

  const projectConfigPath = path.resolve(projectRoot, 'cortex.config.js');
  if (fs.existsSync(projectConfigPath)) {
    Object.assign(resolved, require(projectConfigPath));
    Object.assign(resolved, config);
  }

  return resolved;
}

function resolveProjectRoot(projectRoot, env = process.env, cwd = process.cwd()) {
  return projectRoot || env.PWD || env.INIT_CWD || cwd;
}

/**
 * Register cortex_add_repo and cortex_list_repos tools.
 * `state.engineRef` is a mutable reference to the current engine so that
 * cortex_add_repo can promote a single IndexEngine to MultiRepoEngine at runtime.
 */
function registerMultiRepoTools(server, state, globalConfig, telemetry) {
  server.tool(
    'cortex_list_repos',
    'List all indexed repositories with file and symbol counts',
    {},
    async () => {
      const t0 = performance.now();
      const engine = state.engineRef;
      let repos;

      if (engine instanceof MultiRepoEngine) {
        const status = engine.getStatus();
        repos = status.repos.map((r) => ({
          name: r.name,
          root: r.root,
          fileCount: r.fileCount,
          symbolCount: r.symbolCount,
        }));
      } else {
        const status = engine.getStatus();
        repos = [
          {
            name: path.basename(engine.projectRoot),
            root: engine.projectRoot,
            fileCount: status.fileCount,
            symbolCount: status.symbolCount,
          },
        ];
      }

      const result = {
        content: [{ type: 'text', text: JSON.stringify({ repos }, null, 2) }],
      };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_add_repo',
    'Dynamically add a repository to the index at runtime',
    {
      root_path: z.string().describe('Absolute path to the repository root'),
      name: z.string().optional().describe('Name for the repo (defaults to directory basename)'),
    },
    async (params) => {
      const t0 = performance.now();
      const rootPath = params.root_path;
      const name = params.name || path.basename(rootPath);

      if (!fs.existsSync(rootPath)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Path does not exist: ${rootPath}` }, null, 2),
            },
          ],
        };
      }

      const config = resolveConfig(rootPath, globalConfig);
      const newEngine = new IndexEngine(rootPath, config);
      const currentEngine = state.engineRef;

      if (currentEngine instanceof MultiRepoEngine) {
        if (currentEngine.repos.has(name)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Repo '${name}' already exists` }, null, 2),
              },
            ],
          };
        }
        currentEngine.repos.set(name, { engine: newEngine, root: rootPath, name });
      } else {
        // Promote single IndexEngine to MultiRepoEngine
        const existingName = path.basename(currentEngine.projectRoot);
        const multi = new MultiRepoEngine([], globalConfig);
        multi.repos.set(existingName, {
          engine: currentEngine,
          root: currentEngine.projectRoot,
          name: existingName,
        });
        multi.repos.set(name, { engine: newEngine, root: rootPath, name });
        state.engineRef = multi;
      }

      await newEngine.ready();

      const status = newEngine.getStatus();
      const result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                added: name,
                root: rootPath,
                fileCount: status.fileCount,
                symbolCount: status.symbolCount,
              },
              null,
              2,
            ),
          },
        ],
      };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );
}

async function createServer(projectRoots, config = {}) {
  // Accept a single root string or an array of root strings.
  const rootsArray = Array.isArray(projectRoots) ? projectRoots : [projectRoots];

  const server = new McpServer({
    name: 'cortex-engine',
    version: '1.4.0',
  });

  let engine;
  let primaryRoot;

  if (rootsArray.length > 1) {
    // Multi-repo mode
    const repos = rootsArray.map((r) => ({
      name: path.basename(r),
      root: r,
      config: resolveConfig(r, config),
    }));
    engine = new MultiRepoEngine(repos, config);
    primaryRoot = rootsArray[0];
  } else {
    // Single-repo mode — identical to pre-existing behaviour
    primaryRoot = rootsArray[0];
    const resolvedConfig = resolveConfig(primaryRoot, config);
    engine = new IndexEngine(primaryRoot, resolvedConfig);
  }

  // Mutable state allows cortex_add_repo to promote single->multi at runtime.
  const state = { engineRef: engine };

  const git = new GitIntegration(primaryRoot);
  const knowledge = new Knowledge(primaryRoot, resolveConfig(primaryRoot, config));
  const fleet = new Fleet(knowledge);
  const telemetry = new Telemetry(primaryRoot);

  registerFileTools(server, engine, telemetry);
  registerSearchTools(server, engine, telemetry, state);
  registerGitTools(server, git, telemetry);
  registerKnowledgeTools(server, knowledge, telemetry);
  registerFleetTools(server, fleet, telemetry);
  registerAdminTools(server, engine, telemetry);
  registerMultiRepoTools(server, state, config, telemetry);

  // Clean shutdown
  const cleanup = async () => {
    await state.engineRef.close();
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return { server, engine, git, knowledge, fleet, telemetry, state };
}

async function startStdioServer(projectRoots, config = {}) {
  const started = await createServer(projectRoots, config);
  const transport = new StdioServerTransport();
  await started.server.connect(transport);
  // Index AFTER MCP handshake so clients do not time out during startup.
  await started.state.engineRef.ready();
  return started;
}

// Run as MCP stdio server if invoked directly
if (require.main === module) {
  const args = process.argv.slice(2);
  let roots;
  if (args.length === 0) {
    roots = resolveProjectRoot(undefined);
  } else if (args.length === 1) {
    roots = resolveProjectRoot(args[0]);
  } else {
    roots = args; // multiple roots -- pass the whole array
  }

  startStdioServer(roots)
    .catch((err) => {
      console.error('Failed to start cortex-engine:', err);
      process.exit(1);
    });
}

module.exports = { createServer, resolveConfig, resolveProjectRoot, startStdioServer };
