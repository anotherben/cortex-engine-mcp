const fs = require('fs');
const path = require('path');

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isInsidePath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveInsideRoot(rootPath, candidatePath) {
  if (!rootPath || typeof candidatePath !== 'string' || candidatePath.trim() === '') return null;

  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, candidatePath);
  if (!isInsidePath(root, resolved)) return null;

  return {
    absPath: resolved,
    relPath: toPosixPath(path.relative(root, resolved)),
  };
}

function resolveExistingInsideRoot(rootPath, candidatePath) {
  const lexical = resolveInsideRoot(rootPath, candidatePath);
  if (!lexical) return null;

  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync.native(path.resolve(rootPath));
    realCandidate = fs.realpathSync.native(lexical.absPath);
  } catch {
    return null;
  }

  if (!isInsidePath(realRoot, realCandidate)) return null;

  return {
    absPath: realCandidate,
    relPath: toPosixPath(path.relative(realRoot, realCandidate)),
  };
}

function safeRelativePath(target) {
  const value = String(target || 'global');
  const parts = value
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .map((segment) => (segment === '.' || segment === '..' ? '_' : segment))
    .filter(Boolean);

  return parts.join('/') || 'global';
}

module.exports = {
  isInsidePath,
  resolveExistingInsideRoot,
  resolveInsideRoot,
  safeRelativePath,
  toPosixPath,
};
