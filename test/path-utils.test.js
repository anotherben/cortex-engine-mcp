const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveExistingInsideRoot,
  resolveInsideRoot,
  safeRelativePath,
} = require('../src/path-utils');

describe('path utilities', () => {
  test('resolveInsideRoot rejects parent traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-root-'));
    expect(resolveInsideRoot(root, '../outside.txt')).toBeNull();
  });

  test('resolveInsideRoot normalizes paths inside the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-root-'));
    const resolved = resolveInsideRoot(root, 'src/../src/app.js');
    expect(resolved.relPath).toBe('src/app.js');
    expect(resolved.absPath).toBe(path.join(root, 'src/app.js'));
  });

  test('resolveExistingInsideRoot rejects symlink directory escapes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-outside-'));
    fs.writeFileSync(path.join(outside, 'outside.js'), 'const leaked = true;\n');
    fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'dir');

    expect(resolveExistingInsideRoot(root, 'linked-dir/outside.js')).toBeNull();
  });

  test('safeRelativePath removes traversal segments while preserving useful nesting', () => {
    expect(safeRelativePath('../../src/service.js:handler')).toBe('_/_/src/service.js_handler');
    expect(safeRelativePath('src/services/order service.js')).toBe('src/services/order_service.js');
  });
});
