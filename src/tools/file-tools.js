const { z } = require('zod');
const { estimateTokens, performance } = require('../telemetry');

function registerFileTools(server, engine, telemetry) {
  server.tool(
    'cortex_tree',
    'File tree with optional path prefix filter',
    {
      path_prefix: z.string().optional().describe('Filter by path prefix'),
      depth: z.number().optional().describe('Max depth'),
    },
    async (params) => {
      const t0 = performance.now();
      const files = engine.getTree(params.path_prefix, params.depth);
      const result = { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;
      return telemetry.wrapTimingOnly(result, elapsed);
    },
  );

  server.tool(
    'cortex_outline',
    'List symbols in a file with kind, signature, line range',
    {
      file_path: z.string().describe('Relative file path'),
    },
    async (params) => {
      const t0 = performance.now();
      const outline = engine.getOutline(params.file_path);
      const responseText = JSON.stringify(outline, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      // tokens saved = full file tokens - outline JSON tokens
      const file = engine.store.getFile(params.file_path);
      const fileTokens = file ? Math.ceil(file.sizeBytes / 4) : 0;
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, fileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_read_symbol',
    'Read the full source code of a single symbol',
    {
      file_path: z.string().describe('Relative file path'),
      symbol_name: z.string().describe('Symbol name'),
    },
    async (params) => {
      const t0 = performance.now();
      const source = engine.readSymbol(params.file_path, params.symbol_name);
      if (!source) {
        const result = { content: [{ type: 'text', text: 'Symbol not found' }], isError: true };
        const elapsed = performance.now() - t0;
        if (!telemetry) return result;
        return telemetry.wrapTimingOnly(result, elapsed);
      }
      const result = { content: [{ type: 'text', text: source }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      // tokens saved = full file tokens - symbol source tokens
      const file = engine.store.getFile(params.file_path);
      const fileTokens = file ? Math.ceil(file.sizeBytes / 4) : 0;
      const responseTokens = estimateTokens(source);
      return telemetry.wrapResult(result, fileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_read_symbols',
    'Batch read multiple symbols',
    {
      specs: z
        .array(
          z.object({
            filePath: z.string(),
            symbolName: z.string(),
          }),
        )
        .describe('Array of {filePath, symbolName} to read'),
    },
    async (params) => {
      const t0 = performance.now();
      const results = engine.readSymbols(params.specs);
      const responseText = JSON.stringify(results, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      // tokens saved = sum of all full file tokens - response tokens
      let totalFileTokens = 0;
      const seenFiles = new Set();
      for (const spec of params.specs) {
        if (!seenFiles.has(spec.filePath)) {
          seenFiles.add(spec.filePath);
          const file = engine.store.getFile(spec.filePath);
          if (file) totalFileTokens += Math.ceil(file.sizeBytes / 4);
        }
      }
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, totalFileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_read_range',
    'Read a specific line range from a file',
    {
      file_path: z.string().describe('File path'),
      start_line: z.number().describe('Start line'),
      end_line: z.number().describe('End line'),
    },
    async (params) => {
      const t0 = performance.now();
      const text = engine.readRange(params.file_path, params.start_line, params.end_line);
      if (text === null) {
        const result = { content: [{ type: 'text', text: 'File not found' }], isError: true };
        const elapsed = performance.now() - t0;
        if (!telemetry) return result;
        return telemetry.wrapTimingOnly(result, elapsed);
      }
      const result = { content: [{ type: 'text', text }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      // tokens saved = full file tokens - range tokens
      const file = engine.store.getFile(params.file_path);
      const fileTokens = file ? Math.ceil(file.sizeBytes / 4) : 0;
      const responseTokens = estimateTokens(text);
      return telemetry.wrapResult(result, fileTokens, responseTokens, elapsed);
    },
  );

  server.tool(
    'cortex_context',
    'Get a symbol with its imports and file outline',
    {
      file_path: z.string().describe('File path'),
      symbol_name: z.string().describe('Symbol name'),
    },
    async (params) => {
      const t0 = performance.now();
      const ctx = engine.getContext(params.file_path, params.symbol_name);
      if (!ctx) {
        const result = { content: [{ type: 'text', text: 'Not found' }], isError: true };
        const elapsed = performance.now() - t0;
        if (!telemetry) return result;
        return telemetry.wrapTimingOnly(result, elapsed);
      }
      const responseText = JSON.stringify(ctx, null, 2);
      const result = { content: [{ type: 'text', text: responseText }] };
      const elapsed = performance.now() - t0;
      if (!telemetry) return result;

      // tokens saved = full file tokens - context JSON tokens
      const file = engine.store.getFile(params.file_path);
      const fileTokens = file ? Math.ceil(file.sizeBytes / 4) : 0;
      const responseTokens = estimateTokens(responseText);
      return telemetry.wrapResult(result, fileTokens, responseTokens, elapsed);
    },
  );
}

module.exports = { registerFileTools };
