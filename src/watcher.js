const { watch } = require('chokidar');
const path = require('path');
const EventEmitter = require('events');

const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  '.cortex',
  'dist',
  'build',
  'coverage',
  '.worktrees',
  '.claude',
  '.codex',
  '.agents',
  '.runs',
  '.playwright-cli',
];

const DEFAULT_EXTENSIONS = [
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.json',
  '.yaml',
  '.yml',
  '.graphql',
  '.gql',
  '.md',
  '.toml',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.vue',
  '.svelte',
];

class Watcher extends EventEmitter {
  constructor(rootPath, config = {}) {
    super();
    this.rootPath = path.resolve(rootPath);
    this.config = config;

    this.extensions = new Set(config.extensions || DEFAULT_EXTENSIONS);

    // Build ignore set: default dirs + custom dirs from config.ignorePaths
    const ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
    for (const p of config.ignorePaths || []) {
      // Extract dir name from glob patterns like '**/node_modules/**'
      const match = p.match(/\*\*\/([^/*]+)\/?\*?\*?/);
      if (match) ignoreDirs.add(match[1]);
      else ignoreDirs.add(p);
    }

    // Function-based directory ignore is stable across chokidar major versions.
    const ignoreFn = (filePath) => {
      const parts = filePath.split(/[\\\/]+/);
      return parts.some((part) => ignoreDirs.has(part));
    };

    this.watcher = watch('.', {
      cwd: this.rootPath,
      ignored: ignoreFn,
      persistent: true,
      followSymlinks: false,
      ignoreInitial: false,
      usePolling: config.usePolling ?? false,
      interval: config.pollInterval ?? 100,
    });

    this.watcher.on('add', (relPath) => {
      if (this._isSupportedFile(relPath)) {
        this.emit('add', path.join(this.rootPath, relPath));
      }
    });

    this.watcher.on('change', (relPath) => {
      if (this._isSupportedFile(relPath)) {
        this.emit('change', path.join(this.rootPath, relPath));
      }
    });

    this.watcher.on('unlink', (relPath) => {
      if (this._isSupportedFile(relPath)) {
        this.emit('unlink', path.join(this.rootPath, relPath));
      }
    });

    this._readyPromise = new Promise((resolve) => {
      this.watcher.on('ready', resolve);
    });
  }

  _isSupportedFile(relPath) {
    return this.extensions.has(path.extname(relPath));
  }

  ready() {
    return this._readyPromise;
  }

  /**
   * Returns a flat array of absolute paths for all supported files currently watched.
   * Only valid after ready() resolves.
   */
  getWatchedFiles() {
    const watched = this.watcher.getWatched();
    const results = [];
    for (const [dir, files] of Object.entries(watched)) {
      const absDir = dir === '.' ? this.rootPath : path.join(this.rootPath, dir);
      for (const file of files) {
        const relPath = dir === '.' ? file : path.join(dir, file);
        if (this._isSupportedFile(relPath)) {
          results.push(path.join(absDir, file));
        }
      }
    }
    return results;
  }

  async close() {
    await this.watcher.close();
  }
}

module.exports = Watcher;
