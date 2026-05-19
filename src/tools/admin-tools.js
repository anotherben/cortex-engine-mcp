const { z } = require('zod');
const { performance } = require('../telemetry');

function registerAdminTools(server, engine, telemetry) {
  server.tool(
    'cortex_status',
    'Index health: file count, symbol count, staleness',
    {},
    async () => {
      const t0 = performance.now();
      const stats = engine.getStatus();
      const result = { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_reindex',
    'Force reindex of a specific file or all files',
    {
      file_path: z
        .string()
        .optional()
        .describe('Specific file to reindex (optional - omit for all)'),
    },
    async (params) => {
      const t0 = performance.now();
      engine.reindex(params.file_path);
      const result = { content: [{ type: 'text', text: 'Reindex complete' }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_telemetry',
    'Cumulative token-savings telemetry: queries, tokens saved, cost avoided',
    {},
    async () => {
      const t0 = performance.now();
      if (!telemetry) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'Telemetry not initialized' }, null, 2) },
          ],
        };
      }
      const report = telemetry.getReport();
      const result = { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      const elapsed = performance.now() - t0;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_diagnostic',
    'Run diagnostic checks on the cortex-engine index to verify it is working correctly',
    {},
    async () => {
      const status = engine.getStatus();
      const db = engine.store.db;
      const checks = [];

      checks.push({ check: 'files_indexed', value: status.fileCount, pass: status.fileCount > 0 });
      checks.push({
        check: 'symbols_indexed',
        value: status.symbolCount,
        pass: status.symbolCount > 0,
      });

      let hasSourceType = false;
      try {
        db.prepare('SELECT source_type FROM symbols LIMIT 1').get();
        hasSourceType = true;
      } catch (e) {}
      checks.push({ check: 'source_type_column', value: hasSourceType, pass: hasSourceType });

      let codeCount = 0;
      try {
        codeCount = db
          .prepare("SELECT COUNT(*) as c FROM symbols WHERE source_type = 'code'")
          .get().c;
      } catch (e) {}
      checks.push({ check: 'code_symbols', value: codeCount, pass: codeCount > 0 });

      let findWorks = false;
      try {
        const r = engine.store.findSymbols({ query: 'a' });
        findWorks = Array.isArray(r);
      } catch (e) {}
      checks.push({ check: 'find_symbols_works', value: findWorks, pass: findWorks });

      checks.push({
        check: 'imports_tracked',
        value: status.importCount,
        pass: status.importCount > 0,
      });

      let tagCount = 0;
      try {
        tagCount = db.prepare('SELECT COUNT(*) as c FROM tags').get().c;
      } catch (e) {}
      checks.push({ check: 'semantic_tags', value: tagCount, pass: tagCount > 0 });

      const allPass = checks.every((c) => c.pass);
      const report = {
        verdict: allPass ? 'HEALTHY' : 'ISSUES_FOUND',
        engine_version: '1.0.0',
        project_root: engine.projectRoot,
        checks,
        recommendation: allPass
          ? 'Index is healthy.'
          : 'Delete .cortex/index.db and restart the MCP server to rebuild the index.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    },
  );
}

module.exports = { registerAdminTools };
