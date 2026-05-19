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

function hasNestedQuantifier(pattern) {
  const groupStack = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      groupStack.push(false);
      continue;
    }
    if (ch === ')' && groupStack.length > 0) {
      const groupHadQuantifier = groupStack.pop();
      const next = pattern[i + 1];
      if (groupHadQuantifier && (next === '+' || next === '*' || next === '{')) return true;
      continue;
    }
    if ((ch === '+' || ch === '*') && groupStack.length > 0) {
      groupStack[groupStack.length - 1] = true;
    }
  }
  return false;
}

function hasRepeatedWildcard(pattern) {
  return pattern.includes('.*.*') || pattern.includes('.+.+') || pattern.includes('.*.+') || pattern.includes('.+.*');
}

function hasBackreference(pattern) {
  for (let i = 0; i < pattern.length - 1; i += 1) {
    if (pattern[i] === '\\' && '123456789'.includes(pattern[i + 1])) return true;
  }
  return false;
}

function isUnsafeRegex(pattern) {
  if (typeof pattern !== 'string') return 'Pattern must be a string';
  if (pattern.length > 256) return 'Regex patterns are limited to 256 characters';
  if (hasBackreference(pattern)) return 'Backreferences are not allowed in regex search';
  if (hasNestedQuantifier(pattern)) return 'Nested quantified groups are not allowed in regex search';
  if (hasRepeatedWildcard(pattern)) return 'Repeated wildcard groups are not allowed in regex search';
  return null;
}

function buildSearchRegExp(pattern, { caseSensitive = false, useRegex = false } = {}) {
  if (typeof pattern !== 'string') throw new SearchPatternError('Search pattern must be a string');
  if (pattern.length === 0) throw new SearchPatternError('Search pattern must not be empty');

  const flags = caseSensitive ? '' : 'i';
  if (!useRegex) return new RegExp(escapeRegExp(pattern), flags);

  const unsafeReason = isUnsafeRegex(pattern);
  if (unsafeReason) throw new SearchPatternError(unsafeReason);

  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new SearchPatternError('Invalid regex search pattern: ' + error.message);
  }
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
