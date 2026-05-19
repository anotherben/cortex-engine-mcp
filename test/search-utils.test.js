const {
  buildIdentifierRegExp,
  buildSearchRegExp,
  isUnsafeRegex,
} = require('../src/search-utils');

describe('search utilities', () => {
  test('literal searches escape regex syntax by default', () => {
    const regex = buildSearchRegExp('a+b');
    expect(regex.test('a+b')).toBe(true);
    expect(regex.test('aaab')).toBe(false);
  });

  test('regex mode rejects nested quantified groups', () => {
    expect(isUnsafeRegex('(a+)+$')).toMatch(/Nested/);
    expect(() => buildSearchRegExp('(a+)+$', { useRegex: true })).toThrow(/Nested/);
  });

  test('identifier searches are literal and word bounded', () => {
    const regex = buildIdentifierRegExp('foo.bar');
    expect(regex.test('foo.bar')).toBe(true);
    expect(regex.test('fooXbar')).toBe(false);
  });
});
