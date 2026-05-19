const fs = require('fs');
const os = require('os');
const path = require('path');

const IndexEngine = require('../src/index');

function makeEngine(projectRoot) {
  const engine = Object.create(IndexEngine.prototype);
  engine.projectRoot = projectRoot;
  engine._contentCache = new Map();
  engine.store = {
    getFile: (filePath) => (['src/app.js', 'src/link.txt'].includes(filePath) ? { id: 1, path: filePath } : null),
    deleteFile: jest.fn(),
  };
  engine._indexFile = jest.fn();
  engine._isRegularProjectFile = IndexEngine.prototype._isRegularProjectFile;
  return engine;
}

describe('IndexEngine path boundary checks', () => {
  test('readRange refuses to read outside the project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-index-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.js'), 'const ok = true;\n');
    fs.writeFileSync(path.join(root, '..', 'outside.txt'), 'outside-data\n');

    const engine = makeEngine(root);

    expect(engine.readRange('../outside.txt', 1, 1)).toBeNull();
    expect(engine.readRange('src/app.js', 1, 1)).toBe('const ok = true;');
  });

  test('readRange refuses symlink targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-index-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, '..', 'outside.txt'), 'outside-data\n');
    fs.symlinkSync(path.join(root, '..', 'outside.txt'), path.join(root, 'src', 'link.txt'));

    const engine = makeEngine(root);

    expect(engine.readRange('src/link.txt', 1, 1)).toBeNull();
  });

  test('reindex refuses files reached through symlink directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-index-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-outside-'));
    fs.writeFileSync(path.join(outside, 'outside.js'), 'const leaked = true;\n');
    fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'dir');

    const engine = makeEngine(root);

    expect(engine.reindex('linked-dir/outside.js')).toBe(false);
    expect(engine._indexFile).not.toHaveBeenCalled();
  });

  test('reindex refuses traversal paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-index-'));
    const engine = makeEngine(root);

    expect(engine.reindex('../outside.txt')).toBe(false);
    expect(engine._indexFile).not.toHaveBeenCalled();
  });
});
