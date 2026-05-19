const { z } = require('zod');
const { performance } = require('../telemetry');

function registerKnowledgeTools(server, knowledge, telemetry) {
  server.tool(
    'cortex_annotate',
    'Add a note to a file, symbol, or pattern. Persists across sessions.',
    {
      target: z.string().describe('File path, file:symbol, directory prefix, or "global"'),
      note: z.string().describe('The annotation text'),
      author: z.string().optional().describe('Who is adding this (e.g., "agent", "reviewer")'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags: lesson, pattern, warning, decision, etc.'),
    },
    async (params) => {
      const t0 = performance.now();
      knowledge.annotate(params);
      const result = { content: [{ type: 'text', text: `Annotation saved for ${params.target}` }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_recall',
    'Get all annotations for a file or symbol',
    {
      target: z.string().describe('File path or file:symbol'),
    },
    async (params) => {
      const t0 = performance.now();
      const entries = knowledge.recall(params.target);
      const result = { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_patterns',
    'Get pattern annotations for a directory',
    {
      directory: z.string().describe('Directory prefix to search'),
    },
    async (params) => {
      const t0 = performance.now();
      const patterns = knowledge.patterns(params.directory);
      const result = { content: [{ type: 'text', text: JSON.stringify(patterns, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_lessons',
    'Get lessons learned, optionally filtered by tag',
    {
      tag: z.string().optional().describe('Filter by tag (e.g., "rex", "shopify", "tenant_id")'),
    },
    async (params) => {
      const t0 = performance.now();
      const lessons = knowledge.lessons(params.tag);
      const result = { content: [{ type: 'text', text: JSON.stringify(lessons, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_sync_knowledge',
    'Sync all knowledge annotations to an Obsidian vault. Groups annotations by target and writes one markdown file per target. Only writes files changed since last sync.',
    {
      vault_path: z
        .string()
        .optional()
        .describe(
          'Absolute path to the Obsidian vault directory. Defaults to the OBSIDIAN_VAULT_PATH environment variable.',
        ),
    },
    async (params) => {
      const t0 = performance.now();
      const vaultPath = params.vault_path || process.env.OBSIDIAN_VAULT_PATH;
      const syncResult = knowledge.syncToObsidian(vaultPath);

      let text;
      if (syncResult.error) {
        text = `Sync failed: ${syncResult.error}`;
      } else {
        text = `Obsidian sync complete: ${syncResult.synced} annotation(s) written to ${syncResult.vaultPath} (${syncResult.skipped} already synced)`;
      }

      const result = { content: [{ type: 'text', text }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );
}

module.exports = { registerKnowledgeTools };
