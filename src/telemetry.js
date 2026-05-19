const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Pricing: $/M input tokens
const PRICING = {
  claude_opus_4_6: 15,
  claude_sonnet_4_6: 3,
  claude_haiku_4_5: 0.8,
};

function estimateTokens(str) {
  if (!str) return 0;
  return Math.ceil(Buffer.byteLength(String(str), 'utf8') / 4);
}

function calcCostAvoided(tokensSaved) {
  const result = {};
  for (const [model, pricePerMillion] of Object.entries(PRICING)) {
    result[model] = parseFloat(((tokensSaved / 1_000_000) * pricePerMillion).toFixed(4));
  }
  return result;
}

function _injectMeta(text, meta) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — append as separate JSON block
    return text + '\n' + JSON.stringify({ _meta: meta }, null, 2);
  }

  // Arrays don't serialize non-numeric properties, so wrap in object
  if (Array.isArray(parsed)) {
    return JSON.stringify({ data: parsed, _meta: meta }, null, 2);
  }

  parsed._meta = meta;
  return JSON.stringify(parsed, null, 2);
}

class Telemetry {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.cortexDir = path.join(projectRoot, '.cortex');
    this.filePath = path.join(this.cortexDir, 'telemetry.json');
    this.sessionStart = new Date().toISOString();

    // Load persisted cumulative stats or start fresh
    this._cumulative = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(raw);
        return {
          total_queries: data.total_queries || 0,
          total_tokens_saved: data.total_tokens_saved || 0,
          total_cost_avoided: data.total_cost_avoided || {},
        };
      }
    } catch {
      // Corrupted file — start fresh
    }
    return {
      total_queries: 0,
      total_tokens_saved: 0,
      total_cost_avoided: {},
    };
  }

  _persist() {
    try {
      if (!fs.existsSync(this.cortexDir)) {
        fs.mkdirSync(this.cortexDir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this._cumulative, null, 2));
    } catch {
      // Non-fatal — telemetry persistence is best-effort
    }
  }

  /**
   * Wrap a tool result with _meta telemetry.
   *
   * @param {object} result - The MCP tool result { content: [{ type, text }] }
   * @param {number} fileTokens - Tokens the agent WOULD have read (full file, all matches, etc.)
   * @param {number} responseTokens - Tokens actually returned by cortex
   * @param {number} timingMs - How long the tool call took
   * @returns {object} The result with _meta appended to the text content
   */
  wrapResult(result, fileTokens, responseTokens, timingMs) {
    const tokensSaved = Math.max(0, fileTokens - responseTokens);
    const costAvoided = calcCostAvoided(tokensSaved);

    // Update cumulative stats
    this._cumulative.total_queries += 1;
    this._cumulative.total_tokens_saved += tokensSaved;

    for (const [model, cost] of Object.entries(costAvoided)) {
      this._cumulative.total_cost_avoided[model] = parseFloat(
        ((this._cumulative.total_cost_avoided[model] || 0) + cost).toFixed(4),
      );
    }

    this._persist();

    const meta = {
      timing_ms: parseFloat(timingMs.toFixed(1)),
      tokens_saved: tokensSaved,
      total_tokens_saved: this._cumulative.total_tokens_saved,
      estimate_method: 'byte_approx',
      cost_avoided: costAvoided,
      total_cost_avoided: { ...this._cumulative.total_cost_avoided },
    };

    if (result.content && result.content[0] && result.content[0].type === 'text') {
      result.content[0].text = _injectMeta(result.content[0].text, meta);
    }

    return result;
  }

  /**
   * Wrap a tool result with timing-only _meta (no savings).
   * Used for tools that don't save tokens (status, reindex, git_status, etc.).
   */
  wrapTimingOnly(result, timingMs) {
    this._cumulative.total_queries += 1;
    this._persist();

    const meta = {
      timing_ms: parseFloat(timingMs.toFixed(1)),
    };

    if (result.content && result.content[0] && result.content[0].type === 'text') {
      result.content[0].text = _injectMeta(result.content[0].text, meta);
    }

    return result;
  }

  /**
   * Get cumulative telemetry report.
   */
  getReport() {
    const totalQueries = this._cumulative.total_queries;
    return {
      total_queries: totalQueries,
      total_tokens_saved: this._cumulative.total_tokens_saved,
      total_cost_avoided: { ...this._cumulative.total_cost_avoided },
      session_start: this.sessionStart,
      avg_tokens_saved_per_query:
        totalQueries > 0 ? Math.round(this._cumulative.total_tokens_saved / totalQueries) : 0,
    };
  }
}

module.exports = { Telemetry, estimateTokens, calcCostAvoided, PRICING, performance };
