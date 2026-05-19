const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Map file extensions to source_type categories
const EXTENSION_TO_SOURCE_TYPE = {
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.cjs': 'code',
  '.mjs': 'code',
  '.py': 'code',
  '.sh': 'code',
  '.bash': 'code',
  '.json': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.sql': 'query',
  '.graphql': 'query',
  '.gql': 'query',
  '.md': 'docs',
  '.html': 'markup',
  '.xml': 'markup',
  '.vue': 'markup',
  '.svelte': 'markup',
  '.css': 'style',
  '.scss': 'style',
  '.less': 'style',
};

// Patterns that identify test/spec/mock/fixture files by path segments or filename
const TEST_PATH_PATTERNS = ['__tests__', '__mocks__', '__fixtures__'];

const TEST_FILE_PATTERN = /\.(test|spec)\.[^.]+$/;

// Regex patterns for test-related directory names (e.g. tests/, specs/, mocks/, fixtures/)
const TEST_DIR_PATTERNS = [
  /(?:^|\/)tests?\//,
  /(?:^|\/)specs?\//,
  /(?:^|\/)mocks?\//,
  /(?:^|\/)fixtures?\//,
];

function quarantineCorruptDbFiles(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    const sourcePath = `${dbPath}${suffix}`;
    if (!fs.existsSync(sourcePath)) continue;
    fs.renameSync(sourcePath, `${sourcePath}.corrupt-${stamp}`);
  }
}

function openHealthyDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function getSourceType(filePath) {
  const ext = '.' + filePath.split('.').pop().toLowerCase();
  const baseType = EXTENSION_TO_SOURCE_TYPE[ext] || 'code';

  // Only classify 'code' files as potentially 'test' — config/docs/etc. keep their type
  if (baseType === 'code') {
    // Check filename pattern: foo.test.js, foo.spec.ts, etc.
    if (TEST_FILE_PATTERN.test(filePath)) return 'test';

    // Check path segments for exact directory name matches (e.g. __tests__/, __mocks__/)
    for (const seg of TEST_PATH_PATTERNS) {
      if (filePath.includes('/' + seg + '/') || filePath.startsWith(seg + '/')) return 'test';
    }
    // Check for test-related directory names via regex (tests/, specs/, mocks/, fixtures/)
    for (const pattern of TEST_DIR_PATTERNS) {
      if (pattern.test(filePath)) return 'test';
    }
  }

  return baseType;
}

class Store {
  constructor(dbPath) {
    try {
      this.db = openHealthyDatabase(dbPath);
      if (dbPath !== ':memory:') {
        const integrity = this.db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') {
          throw new Error(`integrity_check=${integrity}`);
        }
      }
    } catch (error) {
      const corrupt =
        error?.code === 'SQLITE_CORRUPT' || /malformed|integrity_check/i.test(String(error?.message));
      if (!corrupt || dbPath === ':memory:') throw error;

      try {
        this.db?.close?.();
      } catch {
        // Ignore close failures while recovering the generated index cache.
      }

      quarantineCorruptDbFiles(dbPath);
      this.db = openHealthyDatabase(dbPath);
    }
  }

  migrate() {
    const schema = fs.readFileSync(path.join(__dirname, 'queries', 'schema.sql'), 'utf-8');
    this.db.exec(schema);

    // Migration: add source_type column if it doesn't exist (for existing DBs)
    const cols = this.db.pragma('table_info(symbols)');
    const hasSourceType = cols.some((c) => c.name === 'source_type');
    if (!hasSourceType) {
      this.db.exec("ALTER TABLE symbols ADD COLUMN source_type TEXT NOT NULL DEFAULT 'code'");
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_source_type ON symbols(source_type)');
      } catch {
        /* index may already exist */
      }
    }
  }

  // --- Files ---

  upsertFile({ path: filePath, language, hash, sizeBytes, lineCount }) {
    const stmt = this.db.prepare(`
      INSERT INTO files (path, language, hash, size_bytes, line_count, indexed_at)
      VALUES (@path, @language, @hash, @sizeBytes, @lineCount, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        language = @language,
        hash = @hash,
        size_bytes = @sizeBytes,
        line_count = @lineCount,
        indexed_at = datetime('now')
    `);
    const info = stmt.run({ path: filePath, language, hash, sizeBytes, lineCount });
    const id =
      info.changes > 0
        ? this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath).id
        : null;
    return { id, path: filePath, language, hash, sizeBytes, lineCount };
  }

  getFile(filePath) {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
    if (!row) return null;
    return {
      id: row.id,
      path: row.path,
      language: row.language,
      hash: row.hash,
      sizeBytes: row.size_bytes,
      lineCount: row.line_count,
      indexedAt: row.indexed_at,
    };
  }

  deleteFile(filePath) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  // --- Symbols ---

  upsertSymbols(fileId, symbols, sourceType = 'code') {
    const del = this.db.prepare('DELETE FROM symbols WHERE file_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line, exported, async, parent_class, source_type)
      VALUES (@fileId, @name, @kind, @signature, @startLine, @endLine, @exported, @async, @parentClass, @sourceType)
    `);

    const tx = this.db.transaction(() => {
      del.run(fileId);
      for (const sym of symbols) {
        ins.run({
          fileId,
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature || '',
          startLine: sym.startLine,
          endLine: sym.endLine,
          exported: sym.exported ? 1 : 0,
          async: sym.async ? 1 : 0,
          parentClass: sym.parentClass || null,
          sourceType: sym.sourceType || sourceType,
        });
      }
    });
    tx();
  }

  getSymbolsByFile(fileId) {
    return this.db
      .prepare(
        `
      SELECT id, file_id, name, kind, signature, start_line AS startLine,
             end_line AS endLine, exported, async, parent_class AS parentClass,
             source_type AS sourceType
      FROM symbols WHERE file_id = ?
    `,
      )
      .all(fileId);
  }

  // --- Imports ---

  upsertImports(fileId, imports) {
    const del = this.db.prepare('DELETE FROM imports WHERE file_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO imports (file_id, source, identifiers, line)
      VALUES (@fileId, @source, @identifiers, @line)
    `);

    const tx = this.db.transaction(() => {
      del.run(fileId);
      for (const imp of imports) {
        ins.run({
          fileId,
          source: imp.source,
          identifiers: JSON.stringify(imp.identifiers || []),
          line: imp.line || 0,
        });
      }
    });
    tx();
  }

  getImportsByFile(fileId) {
    return this.db.prepare('SELECT * FROM imports WHERE file_id = ?').all(fileId);
  }

  // --- Search ---

  getOutlineNested(fileId) {
    const all = this.getSymbolsByFile(fileId);
    const classes = new Map();
    const topLevel = [];

    // First pass: identify classes
    for (const sym of all) {
      if (sym.kind === 'class') {
        classes.set(sym.name, { ...sym, children: [] });
      }
    }

    // Second pass: assign methods to classes, rest to top level
    for (const sym of all) {
      if (sym.kind === 'class') {
        topLevel.push(classes.get(sym.name));
      } else if (sym.parentClass && classes.has(sym.parentClass)) {
        classes.get(sym.parentClass).children.push(sym);
      } else {
        topLevel.push(sym);
      }
    }

    return topLevel;
  }

  /**
   * Split a camelCase or snake_case identifier into lowercase words.
   * "createPurchaseOrder" → ["create", "purchase", "order"]
   * "handle_order_search" → ["handle", "order", "search"]
   * "createPO" → ["create", "p", "o"]  (each uppercase run is its own word)
   */
  _splitIntoWords(name) {
    // Split on underscores and camelCase boundaries (before each uppercase letter)
    return name
      .replace(/([A-Z])/g, ' $1') // insert space before each uppercase letter
      .split(/[\s_]+/) // split on spaces (from above) and underscores
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 0);
  }

  /**
   * Count how many words from queryWords appear in symbolWords (case-insensitive,
   * already lowercased before this call).
   */
  _countWordOverlap(queryWords, symbolWords) {
    const symbolSet = new Set(symbolWords);
    let count = 0;
    for (const qw of queryWords) {
      if (symbolSet.has(qw)) count++;
    }
    return count;
  }

  findSymbols({ query, kind, exportedOnly, limit, sourceTypes } = {}) {
    if (!query || typeof query !== 'string') return [];
    // Default to code + query source types for search
    const types = sourceTypes || ['code', 'query'];

    // Split the query into component words for word-overlap scoring.
    // Handles:
    //   - space-separated queries: "create order" → ["create", "order"]
    //   - camelCase tokens: "createPO" → ["create", "p", "o"]
    //   - snake_case tokens: "handle_order" → ["handle", "order"]
    const queryWords = query
      .split(/\s+/)
      .flatMap((part) => this._splitIntoWords(part))
      .filter((w) => w.length > 0);

    // Build SQL WHERE clause:
    //   - Always include the full query substring match (original behaviour).
    //   - Additionally include per-word substring matches so that "createPO"
    //     (split to ["create","p","o"]) can surface "createPurchaseOrder" via
    //     the "create" word even though '%createPO%' does not match it.
    // This broadens the candidate set; post-processing then rescores and re-sorts.
    const params = {
      pattern: `%${query}%`,
      prefix: `${query}%`,
      exact: query,
    };

    // Build per-word LIKE patterns (only for words with length > 1 to avoid
    // flooding results with single-char matches from short camelCase initials).
    const wordPatternClauses = [];
    queryWords.forEach((w, i) => {
      if (w.length > 1) {
        params[`wpattern_${i}`] = `%${w}%`;
        wordPatternClauses.push(`s.name LIKE @wpattern_${i}`);
      }
    });

    const whereClause =
      wordPatternClauses.length > 0
        ? `(s.name LIKE @pattern OR ${wordPatternClauses.join(' OR ')})`
        : 's.name LIKE @pattern';

    let sql = `
      SELECT s.*, s.source_type AS sourceType, f.path AS filePath,
        (CASE
          WHEN LOWER(s.name) = LOWER(@exact) THEN 100
          WHEN LOWER(s.name) LIKE LOWER(@prefix) THEN 75
          WHEN LOWER(s.name) LIKE LOWER(@pattern) THEN 50
          ELSE 0
        END
        + CASE
          WHEN f.path LIKE 'src/%' THEN 5
          ELSE 0
        END) AS score
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE ${whereClause}
    `;

    // source_type filter
    if (types.length > 0) {
      const placeholders = types.map((_, i) => `@st_${i}`).join(', ');
      sql += ` AND s.source_type IN (${placeholders})`;
      types.forEach((t, i) => {
        params[`st_${i}`] = t;
      });
    }

    if (kind) {
      sql += ' AND s.kind = @kind';
      params.kind = kind;
    }
    if (exportedOnly) {
      sql += ' AND s.exported = 1';
    }
    // Do not apply LIMIT in SQL when we need to post-process and re-sort.
    sql += ' ORDER BY score DESC, s.name';

    const rows = this.db.prepare(sql).all(params);

    // Post-processing: add word-overlap bonus (+25 per matching word) and re-sort.
    // This runs in O(n) on the result set.
    if (queryWords.length > 0) {
      for (const row of rows) {
        const symbolWords = this._splitIntoWords(row.name);
        const overlap = this._countWordOverlap(queryWords, symbolWords);
        row.score = (row.score || 0) + overlap * 25;
      }
      rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    }

    return limit ? rows.slice(0, limit) : rows;
  }

  findImporters(filePath) {
    if (!filePath || typeof filePath !== 'string') return [];
    const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    let base = filePath;
    for (const ext of EXTENSIONS) {
      if (base.endsWith(ext)) {
        base = base.slice(0, -ext.length);
        break;
      }
    }

    const isIndex = base.endsWith('/index') || base === 'index';
    const barrelBase = isIndex ? base.slice(0, base.lastIndexOf('/index')) : null;

    const suffixes = new Set();

    // Generate suffixes from path segments, but require at least 2 segments
    // to avoid false positives (e.g., 'auth' matching every auth-related import)
    const segments = base.split('/');
    const minSegments = segments.length >= 3 ? 2 : 1;
    for (let i = segments.length - 1; i >= 0; i--) {
      const suffix = segments.slice(i).join('/');
      const segmentCount = segments.length - i;
      if (segmentCount < minSegments) continue;
      suffixes.add(suffix);
      for (const ext of EXTENSIONS) {
        suffixes.add(suffix + ext);
      }
    }

    if (barrelBase !== null) {
      const barrelSegments = barrelBase.split('/');
      const barrelMinSegments = barrelSegments.length >= 3 ? 2 : 1;
      for (let i = barrelSegments.length - 1; i >= 0; i--) {
        const suffix = barrelSegments.slice(i).join('/');
        const segmentCount = barrelSegments.length - i;
        if (segmentCount < barrelMinSegments) continue;
        suffixes.add(suffix);
        suffixes.add(suffix + '/');
        for (const ext of EXTENSIONS) {
          suffixes.add(suffix + ext);
        }
      }
    }

    const conditions = [];
    const params = { filePath };

    let idx = 0;
    for (const suffix of suffixes) {
      const pExact = `p_exact_${idx}`;
      const pSlash = `p_slash_${idx}`;
      const pDot = `p_dot_${idx}`;
      conditions.push(`(i.source = @${pExact} OR i.source LIKE @${pSlash} OR i.source = @${pDot})`);
      params[pExact] = suffix;
      params[pSlash] = '%/' + suffix;
      params[pDot] = './' + suffix;
      idx++;
    }

    const whereClause = conditions.join(' OR ');

    const sql = `
      SELECT DISTINCT f.path, f.id
      FROM imports i
      JOIN files f ON f.id = i.file_id
      WHERE (${whereClause})
        AND f.path != @filePath
    `;

    return this.db.prepare(sql).all(params);
  }

  // --- Tags ---

  upsertTags(fileId, symbolTags) {
    const delByFile = this.db.prepare('DELETE FROM tags WHERE file_id = ?');
    const getSymbol = this.db.prepare('SELECT id FROM symbols WHERE file_id = ? AND name = ?');
    const ins = this.db.prepare(
      'INSERT INTO tags (symbol_id, file_id, symbol_name, tag) VALUES (@symbolId, @fileId, @symbolName, @tag)',
    );

    const tx = this.db.transaction(() => {
      delByFile.run(fileId);
      for (const [symbolName, tags] of symbolTags) {
        const sym = getSymbol.get(fileId, symbolName);
        if (!sym) continue;
        for (const tag of tags) {
          ins.run({ symbolId: sym.id, fileId, symbolName, tag });
        }
      }
    });
    tx();
  }

  findByTag(tag, limit) {
    let sql = `
      SELECT t.tag, t.symbol_name, s.kind, s.signature, s.start_line AS startLine,
             s.end_line AS endLine, f.path AS filePath
      FROM tags t
      JOIN symbols s ON s.id = t.symbol_id
      JOIN files f ON f.id = t.file_id
      WHERE t.tag = @tag
      ORDER BY f.path, s.start_line
    `;
    const params = { tag };
    if (limit) {
      sql += ' LIMIT @limit';
      params.limit = limit;
    }
    return this.db.prepare(sql).all(params);
  }

  getTagsForFile(fileId) {
    return this.db.prepare('SELECT symbol_name, tag FROM tags WHERE file_id = ?').all(fileId);
  }

  // --- Stats ---

  getStats() {
    const fileCount = this.db.prepare('SELECT COUNT(*) as c FROM files').get().c;
    const symbolCount = this.db.prepare('SELECT COUNT(*) as c FROM symbols').get().c;
    const importCount = this.db.prepare('SELECT COUNT(*) as c FROM imports').get().c;
    const lastIndexed = this.db.prepare('SELECT MAX(indexed_at) as t FROM files').get().t;
    return { fileCount, symbolCount, importCount, indexedAt: lastIndexed };
  }

  close() {
    this.db.close();
  }
}

module.exports = Store;
module.exports.getSourceType = getSourceType;
