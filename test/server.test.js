const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveConfig, resolveProjectRoot } = require('../src/server');

describe('server configuration helpers', () => {
  test('resolveProjectRoot prefers the explicit root', () => {
    expect(resolveProjectRoot('/tmp/project', { PWD: '/tmp/pwd' }, '/tmp/cwd')).toBe('/tmp/project');
  });

  test('resolveProjectRoot falls back through env and cwd', () => {
    expect(resolveProjectRoot(undefined, { PWD: '/tmp/pwd' }, '/tmp/cwd')).toBe('/tmp/pwd');
    expect(resolveProjectRoot(undefined, { INIT_CWD: '/tmp/init' }, '/tmp/cwd')).toBe('/tmp/init');
    expect(resolveProjectRoot(undefined, {}, '/tmp/cwd')).toBe('/tmp/cwd');
  });

  test('resolveConfig reads cortex.config.js from the target repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-config-'));
    fs.writeFileSync(
      path.join(dir, 'cortex.config.js'),
      "module.exports = { dbPath: '.cache/cortex.db', ignorePaths: ['tmp'] };\n",
    );

    expect(resolveConfig(dir, { usePolling: true })).toEqual({
      dbPath: '.cache/cortex.db',
      ignorePaths: ['tmp'],
      usePolling: true,
    });
  });
});
