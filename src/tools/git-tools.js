const { z } = require('zod');
const { performance } = require('../telemetry');

function registerGitTools(server, gitIntegration, telemetry) {
  server.tool(
    'cortex_git_status',
    'Current branch, uncommitted changes, staged files',
    {},
    async () => {
      const t0 = performance.now();
      const status = await gitIntegration.status();
      const result = { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_git_diff',
    'Diff vs branch/commit. Omit params for uncommitted changes.',
    {
      from: z.string().optional().describe('Base branch or commit'),
      to: z.string().optional().describe('Target branch or commit (default: HEAD)'),
      file: z.string().optional().describe('Specific file to diff'),
    },
    async (params) => {
      const t0 = performance.now();
      const diff = await gitIntegration.diff(params);
      const result = { content: [{ type: 'text', text: diff || '(no changes)' }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_git_blame',
    'Who last changed each line of a file and why',
    {
      file_path: z.string().describe('File to blame'),
    },
    async (params) => {
      const t0 = performance.now();
      try {
        const blame = await gitIntegration.blame(params.file_path);
        const result = { content: [{ type: 'text', text: JSON.stringify(blame, null, 2) }] };
        const elapsed = performance.now() - t0;
        if (!telemetry) return result;
        return telemetry.wrapTimingOnly(result, elapsed);
      } catch (err) {
        const result = {
          content: [{ type: 'text', text: `Blame failed: ${err.message}` }],
          isError: true,
        };
        const elapsed = performance.now() - t0;
        if (!telemetry) return result;
        return telemetry.wrapTimingOnly(result, elapsed);
      }
    },
  );

  server.tool(
    'cortex_git_log',
    'Recent commits, optionally filtered by file',
    {
      file: z.string().optional().describe('Filter to commits touching this file'),
      max_count: z.number().optional().describe('Max commits to return (default: 20)'),
    },
    async (params) => {
      const t0 = performance.now();
      const log = await gitIntegration.log({
        file: params.file,
        maxCount: params.max_count || 20,
      });
      const result = { content: [{ type: 'text', text: JSON.stringify(log, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_git_hotspots',
    'Files with most edits and bug fixes in recent history',
    {
      days: z.number().optional().describe('Lookback period in days (default: 30)'),
      limit: z.number().optional().describe('Max results (default: 20)'),
    },
    async (params) => {
      const t0 = performance.now();
      const hotspots = await gitIntegration.hotspots({
        days: params.days || 30,
        limit: params.limit || 20,
      });
      const result = { content: [{ type: 'text', text: JSON.stringify(hotspots, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );
}

module.exports = { registerGitTools };
