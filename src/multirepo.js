const IndexEngine = require('./index');

class MultiRepoEngine {
  constructor(repos, globalConfig = {}) {
    // repos: [{name: 'app', root: '/path/to/app'}, ...]
    this.repos = new Map();
    for (const repo of repos) {
      this.repos.set(repo.name, {
        engine: new IndexEngine(repo.root, { ...globalConfig, ...repo.config }),
        root: repo.root,
        name: repo.name,
      });
    }
  }

  async ready() {
    const promises = [];
    for (const [, repo] of this.repos) {
      promises.push(repo.engine.ready());
    }
    await Promise.all(promises);
  }

  // --- Query API (delegating to per-repo engines) ---

  getOutline(repoName, filePath) {
    const repo = this.repos.get(repoName);
    if (!repo) return [];
    return repo.engine.getOutline(filePath);
  }

  readSymbol(repoName, filePath, symbolName) {
    const repo = this.repos.get(repoName);
    if (!repo) return null;
    return repo.engine.readSymbol(filePath, symbolName);
  }

  readRange(repoName, filePath, startLine, endLine) {
    const repo = this.repos.get(repoName);
    if (!repo) return null;
    return repo.engine.readRange(filePath, startLine, endLine);
  }

  findSymbol(query, opts = {}) {
    const results = [];
    for (const [name, repo] of this.repos) {
      const repoResults = repo.engine.findSymbol(query, opts);
      for (const r of repoResults) {
        results.push({ ...r, repo: name });
      }
    }
    return results.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  findText(pattern, opts = {}) {
    const results = [];
    for (const [name, repo] of this.repos) {
      const repoResults = repo.engine.findText(pattern, opts);
      for (const r of repoResults) {
        results.push({ ...r, repo: name });
      }
    }
    return results;
  }

  findByTag(tag, limit) {
    const results = [];
    for (const [name, repo] of this.repos) {
      const repoResults = repo.engine.findByTag(tag, limit);
      for (const r of repoResults) {
        results.push({ ...r, repo: name });
      }
    }
    return limit ? results.slice(0, limit) : results;
  }

  findImporters(repoName, filePath) {
    const repo = this.repos.get(repoName);
    if (!repo) return [];
    return repo.engine.findImporters(filePath);
  }

  getTree(repoName, pathPrefix, depth) {
    if (repoName) {
      const repo = this.repos.get(repoName);
      if (!repo) return [];
      return repo.engine.getTree(pathPrefix, depth);
    }
    // All repos
    const result = {};
    for (const [name, repo] of this.repos) {
      result[name] = repo.engine.getTree(pathPrefix, depth);
    }
    return result;
  }

  getStatus() {
    const repos = [];
    let totalFiles = 0;
    let totalSymbols = 0;
    let totalImports = 0;

    for (const [name, repo] of this.repos) {
      const stats = repo.engine.getStatus();
      repos.push({ name, root: repo.root, ...stats });
      totalFiles += stats.fileCount;
      totalSymbols += stats.symbolCount;
      totalImports += stats.importCount;
    }

    return { repos, totalFiles, totalSymbols, totalImports };
  }

  async close() {
    for (const [, repo] of this.repos) {
      await repo.engine.close();
    }
  }
}

module.exports = MultiRepoEngine;
