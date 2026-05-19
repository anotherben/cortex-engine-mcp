// DB read patterns — SQL SELECT via various client styles + ORM finders
const DB_READ_PATTERN =
  /(?:pool|client|db|connection)\.query\s*\(\s*['"`]SELECT|\bprisma\.\w+\.(?:findMany|findFirst|findUnique|findOne|count|aggregate|groupBy)\s*\(|\bdb\.(?:select|from)\s*\(|\b(?:knex|db)\s*\(\s*['"`]\w|\bknex\s*\.\s*select\s*\(|\.select\s*\(/i;

// DB write patterns — SQL INSERT/UPDATE/DELETE via various client styles + ORM mutations
const DB_WRITE_PATTERN =
  /(?:pool|client|db|connection)\.query\s*\(\s*['"`](?:INSERT|UPDATE|DELETE)|\bprisma\.\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(/i;

// Any DB call — used for tenant-scope and error-handling checks
const DB_CALL_PATTERN =
  /(?:pool|client|db|connection)\.query\s*\(|\bprisma\.\w+\.\w+\s*\(|\b(?:knex|db)\s*\(\s*['"`]\w|\bknex\s*\.\s*(?:select|insert|update|delete|from|where)\s*\(|\.(?:select|insert|update|delete|where)\s*\(/;

const TENANT_SCOPED_PATTERN = /tenant_id/;
const TRY_CATCH_PATTERN = /\btry\s*\{/;

// Route patterns — Express-style (router/app) + TS decorator style
const ROUTE_PATTERN =
  /(?:router|app)\.(get|post|put|delete|patch)\s*\(|@(Get|Post|Put|Delete|Patch)\s*\(/;

const MODULE_EXPORTS_PATTERN = /module\.exports\s*=\s*\{([^}]+)\}/;
const EXPORTS_PATTERN = /exports\.(\w+)/g;

// Auth patterns — decorators, middleware helpers
const AUTH_PATTERN = /@(?:Auth|Guard|UseGuards)\s*\(|authenticate\s*[,(]|requireAuth\s*[,(]/;

// Validation patterns — class-validator decorators, zod, joi
const VALIDATION_PATTERN =
  /@(?:Body|Param|Query)\s*\(|validate\s*\(|schema\.parse\s*\(|\.safeParse\s*\(/;

class Tagger {
  constructor(config = {}) {
    this.customRules = config.customRules || [];
  }

  /**
   * Tag symbols based on the source code they contain.
   * Returns a Map<symbolName, string[]> of tags per symbol.
   */
  tagSymbols(symbols, fullSource) {
    const lines = fullSource.split('\n');
    const result = new Map();

    for (const sym of symbols) {
      const tags = [];
      const symSource = lines.slice(sym.startLine - 1, sym.endLine).join('\n');

      // Async
      if (sym.async) tags.push('async');

      // DB patterns
      if (DB_READ_PATTERN.test(symSource)) tags.push('db_read');
      if (DB_WRITE_PATTERN.test(symSource)) tags.push('db_write');

      // Tenant scoping
      if (DB_CALL_PATTERN.test(symSource)) {
        if (TENANT_SCOPED_PATTERN.test(symSource)) {
          tags.push('tenant_scoped');
        } else {
          tags.push('unscoped_query');
        }
      }

      // Error handling
      if (TRY_CATCH_PATTERN.test(symSource)) {
        tags.push('error_handler');
      } else if (DB_CALL_PATTERN.test(symSource) || /await\s+fetch/.test(symSource)) {
        tags.push('no_error_handling');
      }

      // Auth
      if (AUTH_PATTERN.test(symSource)) tags.push('auth');

      // Validation
      if (VALIDATION_PATTERN.test(symSource)) tags.push('validated');

      // Route handler — detect router.get/post/etc inside function bodies
      if (ROUTE_PATTERN.test(symSource)) tags.push('route_handler');

      // Custom rules
      for (const rule of this.customRules) {
        if (rule.pattern.test(symSource)) {
          tags.push(rule.tag);
        }
      }

      result.set(sym.name, tags);
    }

    return result;
  }

  /**
   * Tag source-level patterns (not symbol-scoped).
   * Returns an array of {tag, name?, line?} entries.
   */
  tagSource(source) {
    const tags = [];
    const lines = source.split('\n');

    // Route handlers
    lines.forEach((line, i) => {
      if (ROUTE_PATTERN.test(line)) {
        const match = line.match(ROUTE_PATTERN);
        // group 1 = Express-style verb, group 2 = decorator verb
        const verb = match[1] || match[2];
        tags.push({
          tag: 'route_handler',
          name: verb ? `${verb.toUpperCase()} route` : 'route',
          line: i + 1,
        });
      }
    });

    // module.exports
    const exportsMatch = source.match(MODULE_EXPORTS_PATTERN);
    if (exportsMatch) {
      const names = exportsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const name of names) {
        tags.push({ tag: 'exported', name, line: null });
      }
    }

    // exports.X
    let m;
    const exportsRegex = new RegExp(EXPORTS_PATTERN.source, 'g');
    while ((m = exportsRegex.exec(source)) !== null) {
      tags.push({ tag: 'exported', name: m[1], line: null });
    }

    return tags;
  }

  /**
   * Scan source for module-level route patterns and attribute them to the nearest
   * enclosing symbol by line number.  Returns a Map<symbolName, string[]> of
   * additional tags to merge with the result of tagSymbols().
   *
   * This is needed for JS files where router.post() calls live at module scope
   * (not inside a named factory function) — tagSymbols() never sees them because
   * there is no symbol body that contains them.
   */
  tagSourceSymbols(symbols, source) {
    const extra = new Map();
    if (!symbols || symbols.length === 0) return extra;

    const lines = source.split('\n');

    lines.forEach((line, i) => {
      const lineNum = i + 1; // 1-based
      if (!ROUTE_PATTERN.test(line)) return;

      // Find the innermost symbol that spans this line.
      // 'Innermost' = smallest (endLine - startLine) range that still contains lineNum.
      let best = null;
      for (const sym of symbols) {
        if (sym.startLine <= lineNum && sym.endLine >= lineNum) {
          if (best === null || sym.endLine - sym.startLine < best.endLine - best.startLine) {
            best = sym;
          }
        }
      }

      if (best) {
        if (!extra.has(best.name)) extra.set(best.name, []);
        const tags = extra.get(best.name);
        if (!tags.includes('route_handler')) tags.push('route_handler');
      }
    });

    return extra;
  }

  /**
   * Get all tags for a file — combines symbol-level and source-level tags.
   */
  tagFile(symbols, source) {
    const symbolTags = this.tagSymbols(symbols, source);
    const sourceTags = this.tagSource(source);
    return { symbolTags, sourceTags };
  }
}

module.exports = Tagger;
