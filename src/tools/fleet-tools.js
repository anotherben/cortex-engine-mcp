const { z } = require('zod');
const { performance } = require('../telemetry');

function registerFleetTools(server, fleet, telemetry) {
  server.tool(
    'cortex_ingest_handover',
    'Extract lessons from a worker handover and add to knowledge store',
    {
      markdown: z.string().describe('Handover markdown content'),
      worker_id: z.string().describe('ID of the worker that produced the handover'),
    },
    async (params) => {
      const t0 = performance.now();
      const count = fleet.ingestHandover(params.markdown, params.worker_id);
      const result = {
        content: [{ type: 'text', text: `Ingested ${count} lessons from ${params.worker_id}` }],
      };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_learning_report',
    'Fleet-wide learning report: annotations, lessons, patterns by author and target',
    {},
    async () => {
      const t0 = performance.now();
      const report = fleet.learningReport();
      const result = { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_fleet_mcp_config',
    'Get MCP server config for cortex-engine (for conductor dispatch)',
    {
      project_root: z.string().describe('Project root path'),
    },
    async (params) => {
      const t0 = performance.now();
      const config = fleet.getMcpConfig(params.project_root);
      const result = { content: [{ type: 'text', text: JSON.stringify(config, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );
}

module.exports = { registerFleetTools };
