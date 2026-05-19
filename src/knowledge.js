const fs = require('fs');
const path = require('path');
const { resolveInsideRoot, safeRelativePath } = require('./path-utils');

class Knowledge {
  constructor(projectRoot, config = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.cortexDir = path.join(this.projectRoot, '.cortex');
    this.jsonlPath = path.join(this.cortexDir, 'knowledge.jsonl');
    this.obsidianVault = config.obsidianVault || null;

    // In-memory store indexed by target
    this._entries = [];

    // Track how many entries have been written to Obsidian (per vault path)
    // Maps vaultPath -> number of entries already synced
    this._syncedCounts = new Map();

    // Load existing JSONL if present
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.jsonlPath)) return;
    const content = fs.readFileSync(this.jsonlPath, 'utf-8').trim();
    if (!content) return;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        this._entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }

  _persist(entry) {
    if (!fs.existsSync(this.cortexDir)) {
      fs.mkdirSync(this.cortexDir, { recursive: true });
    }
    fs.appendFileSync(this.jsonlPath, JSON.stringify(entry) + '\n');
  }

  _syncToObsidian(entry) {
    if (!this.obsidianVault) return;
    const outDir = path.join(this.obsidianVault, '_cortex');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // Write a markdown file per annotation
    const slug = entry.target.replace(/[\/:.]/g, '-').replace(/-+/g, '-');
    const ts = new Date(entry.timestamp).toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}-${slug}.md`;

    const content = `---\ntarget: ${entry.target}\nauthor: ${entry.author || 'unknown'}\ntags: [${(entry.tags || []).join(', ')}]\ndate: ${entry.timestamp}\n---\n\n${entry.note}\n`;

    fs.writeFileSync(path.join(this.obsidianVault, '_cortex', filename), content);
  }

  /**
   * Sync all annotations (or only new ones since last sync) to an Obsidian vault.
   * Groups annotations by target file and writes one markdown file per target at:
   *   {vaultPath}/_cortex/{relative-path}.md
   *
   * The sync is additive — existing Obsidian files are never deleted.
   * Tracks a sync count per vault so repeated calls only write new entries.
   *
   * @param {string} [vaultPath] - Path to Obsidian vault. Defaults to this.obsidianVault.
   * @returns {{ synced: number, skipped: number, vaultPath: string }|{ error: string, synced: number }}
   */
  syncToObsidian(vaultPath) {
    const resolvedVault = vaultPath || this.obsidianVault;

    if (!resolvedVault) {
      return { error: 'No vault path provided and OBSIDIAN_VAULT_PATH is not set', synced: 0 };
    }

    if (!fs.existsSync(resolvedVault)) {
      console.warn(`[cortex] Obsidian vault path does not exist: ${resolvedVault} — skipping sync`);
      return { error: `Vault path does not exist: ${resolvedVault}`, synced: 0 };
    }

    const outDir = path.join(resolvedVault, '_cortex');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Only process entries we haven't yet written to this vault
    const alreadySynced = this._syncedCounts.get(resolvedVault) || 0;
    const toSync = this._entries.slice(alreadySynced);
    const skipped = alreadySynced;

    // Group by target
    const byTarget = new Map();
    for (const entry of toSync) {
      const target = entry.target || 'global';
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push(entry);
    }

    let synced = 0;

    for (const [target, entries] of byTarget) {
      // Build a filesystem-safe relative path from target.
      const relPath = safeRelativePath(target);
      const resolvedTarget = resolveInsideRoot(outDir, relPath + '.md');
      if (!resolvedTarget) continue;
      const mdPath = resolvedTarget.absPath;

      // Ensure subdirectory exists
      fs.mkdirSync(path.dirname(mdPath), { recursive: true });

      // Build the file content. If the file already exists, append new sections.
      let existingContent = '';
      if (fs.existsSync(mdPath)) {
        existingContent = fs.readFileSync(mdPath, 'utf-8');
      }

      const newSections = entries.map((e) => {
        const tags = (e.tags || []).join(', ');
        const tagLine = tags ? ` - ${tags}` : '';
        return `### ${e.timestamp}${tagLine}\n\n${e.note}`;
      });

      let fileContent;
      if (existingContent) {
        // Append new sections after existing content
        fileContent = existingContent.trimEnd() + '\n\n' + newSections.join('\n\n') + '\n';
      } else {
        // Fresh file: write header + sections
        fileContent = `## ${target}\n\n` + newSections.join('\n\n') + '\n';
      }

      fs.writeFileSync(mdPath, fileContent);
      synced += entries.length;
    }

    // Advance sync cursor for this vault
    this._syncedCounts.set(resolvedVault, alreadySynced + toSync.length);

    return { synced, skipped, vaultPath: resolvedVault };
  }

  annotate({ target, note, author, tags } = {}) {
    const entry = {
      target,
      note,
      author: author || 'unknown',
      tags: tags || [],
      timestamp: new Date().toISOString(),
    };

    this._entries.push(entry);
    this._persist(entry);
    this._syncToObsidian(entry);
  }

  recall(target) {
    // If target is a symbol (file:symbol), also return file-level annotations
    const parts = target.split(':');
    const file = parts[0];

    return this._entries.filter((e) => {
      if (e.target === target) return true;
      if (parts.length > 1 && e.target === file) return true;
      return false;
    });
  }

  patterns(directoryPrefix) {
    return this._entries.filter((e) => {
      return e.target.startsWith(directoryPrefix) && (e.tags || []).includes('pattern');
    });
  }

  lessons(tag) {
    return this._entries.filter((e) => {
      const tags = e.tags || [];
      if (!tags.includes('lesson')) return false;
      if (tag && !tags.includes(tag)) return false;
      return true;
    });
  }

  all() {
    return [...this._entries];
  }
}

module.exports = Knowledge;
