const {
  buildIdentifierRegExp,
  buildSearchRegExp,
} = require('../src/search-utils');

describe('search utilities', () => {
  test('literal searches escape regex syntax by default', () => {
    const regex = buildSearchRegExp('a+b');
    expect(regex.test('a+b')).toBe(true);
    expect(regex.test('aaab')).toBe(false);
  });

  test('regex mode is disabled to avoid user-controlled backtracking', () => {
    expect(() => buildSearchRegExp('(a+)+$', { useRegex: true })).toThrow(/disabled/);
    expect(() => buildSearchRegExp('(a{1,})+$', { useRegex: true })).toThrow(/disabled/);
  });

  test('regex-looking patterns are literal by default', () => {
    const regex = buildSearchRegExp('(a+)+$');
    expect(regex.test('(a+)+$')).toBe(true);
    expect(regex.test('aaaaaaaa')).toBe(false);
  });

  test('identifier searches are literal and word bounded', () => {
    const regex = buildIdentifierRegExp('foo.bar');
    expect(regex.test('foo.bar')).toBe(true);
    expect(regex.test('fooXbar')).toBe(false);
  });
});
