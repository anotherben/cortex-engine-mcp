const fs = require('fs');
const os = require('os');
const path = require('path');

const Knowledge = require('../src/knowledge');

describe('Knowledge Obsidian sync path safety', () => {
  test('annotation targets cannot write outside the _cortex directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-knowledge-'));
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-vault-'));
    const knowledge = new Knowledge(root);
    knowledge._entries = [
      {
        target: '../../outside',
        note: 'hello',
        author: 'agent',
        tags: ['lesson'],
        timestamp: '2026-05-19T00:00:00.000Z',
      },
    ];

    const result = knowledge.syncToObsidian(vault);

    expect(result.synced).toBe(1);
    expect(fs.existsSync(path.join(vault, 'outside.md'))).toBe(false);
    expect(fs.existsSync(path.join(vault, '_cortex', '_', '_', 'outside.md'))).toBe(true);
  });
});
