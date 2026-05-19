const simpleGit = require('simple-git');
const path = require('path');

class GitIntegration {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.git = simpleGit(this.projectRoot);
  }

  async status() {
    const s = await this.git.status();
    return {
      branch: s.current,
      tracking: s.tracking || null,
      ahead: s.ahead || 0,
      behind: s.behind || 0,
      staged: s.staged || [],
      modified: s.modified || [],
      untracked: s.not_added || [],
      conflicted: s.conflicted || [],
    };
  }

  async log({ file, maxCount = 20 } = {}) {
    const opts = { maxCount };
    if (file) opts.file = file;

    const result = await this.git.log(opts);
    return (result.all || []).map((entry) => ({
      hash: entry.hash,
      message: entry.message,
      date: entry.date,
      author: entry.author_name,
      email: entry.author_email,
    }));
  }

  async diff({ from, to, file } = {}) {
    const args = [];
    if (from && to) {
      args.push(`${from}...${to}`);
    } else if (from) {
      args.push(`${from}...HEAD`);
    }
    if (file) args.push('--', file);

    return this.git.diff(args);
  }

  async blame(filePath) {
    // simple-git doesn't have a built-in blame, use raw
    const raw = await this.git.raw(['blame', '--porcelain', filePath]);
    return this._parsePorcelainBlame(raw);
  }

  _parsePorcelainBlame(raw) {
    const lines = raw.split('\n');
    const results = [];
    let current = {};
    let lineNum = 0;

    for (const line of lines) {
      if (line.startsWith('\t')) {
        // Content line
        current.content = line.substring(1);
        current.line = lineNum;
        results.push({ ...current });
        current = {};
      } else if (line.match(/^[0-9a-f]{40}/)) {
        // Hash line: <hash> <orig-line> <final-line> [<num-lines>]
        const parts = line.split(' ');
        current.hash = parts[0];
        lineNum = parseInt(parts[2], 10);
      } else if (line.startsWith('author ')) {
        current.author = line.substring(7);
      } else if (line.startsWith('author-time ')) {
        current.timestamp = parseInt(line.substring(12), 10);
      } else if (line.startsWith('summary ')) {
        current.summary = line.substring(8);
      }
    }

    return results;
  }

  async hotspots({ days = 30, limit = 20 } = {}) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    // Get commit log with file stats
    const raw = await this.git.raw([
      'log',
      `--since=${sinceStr}`,
      '--name-only',
      '--pretty=format:__COMMIT__%H %s',
    ]);

    const fileCounts = {};
    const bugFixCounts = {};
    let currentIsBugFix = false;

    for (const line of raw.split('\n')) {
      if (line.startsWith('__COMMIT__')) {
        const msg = line.substring(10);
        currentIsBugFix = /\bfix\b/i.test(msg);
      } else if (line.trim()) {
        const file = line.trim();
        fileCounts[file] = (fileCounts[file] || 0) + 1;
        if (currentIsBugFix) {
          bugFixCounts[file] = (bugFixCounts[file] || 0) + 1;
        }
      }
    }

    const hotspots = Object.entries(fileCounts)
      .map(([file, editCount]) => ({
        file,
        editCount,
        bugFixCount: bugFixCounts[file] || 0,
        score: editCount + (bugFixCounts[file] || 0) * 2, // Bug fixes weighted 2x
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return hotspots;
  }

  async diffSymbols(from, parser) {
    // Symbol-level diff: which functions changed between branches?
    const diffText = await this.diff({ from });
    const changedFiles = [];
    let currentFile = null;
    const changedLines = {};

    for (const line of diffText.split('\n')) {
      if (line.startsWith('+++ b/')) {
        currentFile = line.substring(6);
        changedLines[currentFile] = [];
      } else if (line.startsWith('@@ ')) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (match && currentFile) {
          const start = parseInt(match[1], 10);
          const count = parseInt(match[2] || '1', 10);
          for (let i = start; i < start + count; i++) {
            changedLines[currentFile].push(i);
          }
        }
      }
    }

    return changedLines;
  }
}

module.exports = GitIntegration;
