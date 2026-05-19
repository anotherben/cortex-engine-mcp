const { z } = require('zod');
const { estimateTokens, performance } = require('../telemetry');
const MultiRepoEngine = require('../multirepo');

/**
 * Return the engine to use for a given request.
 * When a `repo` filter is specified and the engine is a MultiRepoEngine,
 * return the per-repo IndexEngine so callers get the same API surface.
 * Otherwise return the top-level engine unchanged.
 */
function resolveEngine(engine, state, repoFilter) {
  // Always prefer the live engine from state (may be promoted after add_repo)
  const liveEngine = (state && state.engineRef) || engine;

  if (repoFilter && liveEngine instanceof MultiRepoEngine) {
    const repo = liveEngine.repos.get(repoFilter);
    return repo ? repo.engine : null; // null => repo not found
  }
  return liveEngine;
}

function registerSearchTools(server, engine, telemetry, state) {
  server.tool(
    'cortex_find_symbol',
    'Search symbols by name across all indexed files',
    {
      query: z.string().describe('Search query (substring match)'),
      kind: z.string().optional().describe('Filter by kind: function, class, method, variable'),
      exported_only: z.boolean().optional().describe('Only exported symbols'),
      limit: z.number().optional().describe('Max results'),
      source_types: z
        .array(z.string())
        .optional()
        .describe(
          'Filter by source type: code, test, config, query, docs, markup, style. Defaults to [code, query] (excludes test files).',
        ),
      repo: z.string().optional().describe('Filter to a specific repo name (multi-repo only)'),
    },
    async (params) => {
      const t0 = performance.now();
      const eng = resolveEngine(engine, state, params.repo);
      if (!eng) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: `Repo '${params.repo}' not found` }) },
          ],
        };
      }
      const results = eng.findSymbol(params.query, {
        kind: params.kind,
        exportedOnly: params.exported_only,
        limit: params.limit,
        sourceTypes: params.source_types,
      });
      const responseText = JSON.stringify(results, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      let totalFileTokens = 0;
      const seenFiles = new Set();
      for (const r of results) {
        if (r.filePath && !seenFiles.has(r.filePath)) {
          seenFiles.add(r.filePath);
          const file = eng.store && eng.store.getFile(r.filePath);
          if (file) totalFileTokens += Math.ceil(file.sizeBytes / 4);
        }
      }
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, totalFileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_find_text',
    'Regex/literal search across indexed file contents',
    {
      pattern: z.string().describe('Search pattern. Treated as literal text unless use_regex is true.'),
      case_sensitive: z.boolean().optional().describe('Case sensitive search'),
      use_regex: z.boolean().optional().describe('Treat pattern as a constrained regular expression'),
      repo: z.string().optional().describe('Filter to a specific repo name (multi-repo only)'),
    },
    async (params) => {
      const t0 = performance.now();
      const eng = resolveEngine(engine, state, params.repo);
      if (!eng) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: `Repo '${params.repo}' not found` }) },
          ],
        };
      }
      let results;
      try {
        results = eng.findText(params.pattern, {
          caseSensitive: params.case_sensitive,
          useRegex: params.use_regex === true,
        });
      } catch (err) {
        const result = {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
          isError: true,
        };
        const elapsed = performance.now() - t0;
        if (!telemetry) return result;
        return telemetry.wrapTimingOnly(result, elapsed);
      }
      const responseText = JSON.stringify(results, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      let totalFileTokens = 0;
      const seenFiles = new Set();
      for (const r of results) {
        if (r.filePath && !seenFiles.has(r.filePath)) {
          seenFiles.add(r.filePath);
          const file = eng.store && eng.store.getFile(r.filePath);
          if (file) totalFileTokens += Math.ceil(file.sizeBytes / 4);
        }
      }
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, totalFileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_find_references',
    'Find all references to an identifier across files',
    {
      identifier: z.string().describe('Identifier to search for'),
      repo: z.string().optional().describe('Filter to a specific repo name (multi-repo only)'),
    },
    async (params) => {
      const t0 = performance.now();
      const eng = resolveEngine(engine, state, params.repo);
      if (!eng) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: `Repo '${params.repo}' not found` }) },
          ],
        };
      }
      let results;
      try {
        results = eng.findReferences(params.identifier);
      } catch (err) {
        const result = {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
          isError: true,
        };
        const elapsed = performance.now() - t0;
        if (!telemetry) return result;
        return telemetry.wrapTimingOnly(result, elapsed);
      }
      const responseText = JSON.stringify(results, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      let totalFileTokens = 0;
      const seenFiles = new Set();
      for (const r of results) {
        if (r.filePath && !seenFiles.has(r.filePath)) {
          seenFiles.add(r.filePath);
          const file = eng.store && eng.store.getFile(r.filePath);
          if (file) totalFileTokens += Math.ceil(file.sizeBytes / 4);
        }
      }
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, totalFileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_find_importers',
    'Find files that import a given file',
    {
      file_path: z.string().describe('File path to find importers of'),
      repo: z.string().optional().describe('Filter to a specific repo name (multi-repo only)'),
    },
    async (params) => {
      const t0 = performance.now();
      const eng = resolveEngine(engine, state, params.repo);
      if (!eng) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: `Repo '${params.repo}' not found` }) },
          ],
        };
      }
      const results = eng.findImporters(params.file_path);
      const responseText = JSON.stringify(results, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      let totalFileTokens = 0;
      for (const r of results) {
        if (r.path) {
          const file = eng.store && eng.store.getFile(r.path);
          if (file) totalFileTokens += Math.ceil(file.sizeBytes / 4);
        }
      }
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, totalFileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_find_by_tag',
    'Find symbols by semantic tag (db_read, db_write, unscoped_query, route_handler, etc.)',
    {
      tag: z.string().describe('Semantic tag to search for'),
      limit: z.number().optional().describe('Max results'),
      repo: z.string().optional().describe('Filter to a specific repo name (multi-repo only)'),
    },
    async (params) => {
      const t0 = performance.now();
      const eng = resolveEngine(engine, state, params.repo);
      if (!eng) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: `Repo '${params.repo}' not found` }) },
          ],
        };
      }
      const results = eng.findByTag(params.tag, params.limit);
      const responseText = JSON.stringify(results, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      let totalFileTokens = 0;
      const seenFiles = new Set();
      for (const r of results) {
        if (r.filePath && !seenFiles.has(r.filePath)) {
          seenFiles.add(r.filePath);
          const file = eng.store && eng.store.getFile(r.filePath);
          if (file) totalFileTokens += Math.ceil(file.sizeBytes / 4);
        }
      }
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, totalFileTokens, responseTokens, elapsed);
    },
  );
}

module.exports = { registerSearchTools };
