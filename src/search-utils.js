class SearchPatternError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchPatternError';
  }
}

function escapeRegExp(value) {
  const specials = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);
  return String(value)
    .split('')
    .map((ch) => (specials.has(ch) ? '\\' + ch : ch))
    .join('');
}

function isUnsafeRegex(pattern) {
  if (typeof pattern !== 'string') return 'Pattern must be a string';
  return 'Regex search is disabled; use literal text search';
}

function buildSearchRegExp(pattern, { caseSensitive = false, useRegex = false } = {}) {
  if (typeof pattern !== 'string') throw new SearchPatternError('Search pattern must be a string');
  if (pattern.length === 0) throw new SearchPatternError('Search pattern must not be empty');
  if (useRegex) {
    throw new SearchPatternError(isUnsafeRegex(pattern));
  }

  const flags = caseSensitive ? '' : 'i';
  return new RegExp(escapeRegExp(pattern), flags);
}

function buildIdentifierRegExp(identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new SearchPatternError('Identifier must be a non-empty string');
  }
  if (identifier.length > 256) {
    throw new SearchPatternError('Identifier searches are limited to 256 characters');
  }
  return new RegExp('\\b' + escapeRegExp(identifier) + '\\b');
}

module.exports = {
  SearchPatternError,
  buildIdentifierRegExp,
  buildSearchRegExp,
  escapeRegExp,
  isUnsafeRegex,
};
