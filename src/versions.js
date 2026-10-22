// Ordering of the stored versions of one document. DOM-free so it can be unit-tested.

/** Milliseconds since the epoch, or null for a missing or unparsable time. */
function timeOf(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// A missing time counts as newer than any real one: working copies and API-created versions come after imports.
function compareTime(a, b) {
  const x = timeOf(a);
  const y = timeOf(b);
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
}

/** Negative when `a` is older than `b`, positive when newer, 0 only for the same versionId. Antisymmetric. */
export function compareVersions(a, b) {
  const byWrite = compareTime(a.fileLastWriteTimeUtc, b.fileLastWriteTimeUtc);
  if (byWrite) return byWrite;
  const byCreation = compareTime(a.fileCreationTimeUtc, b.fileCreationTimeUtc);
  if (byCreation) return byCreation;
  if (a.versionId === b.versionId) return 0;
  return a.versionId < b.versionId ? -1 : 1;
}

export function isOlder(a, b) {
  return compareVersions(a, b) < 0;
}

/** A copy of `versions`, newest first. */
export function sortNewestFirst(versions) {
  return [...versions].sort((a, b) => compareVersions(b, a));
}

/**
 * The versions other than `current`, newest first, plus the "previous" (newest one older than `current`)
 * and "latest" (the newest one, when it is newer than `current`) entries used for the tags.
 */
export function describeVersions(all, current) {
  const others = sortNewestFirst(all.filter((version) => version.versionId !== current.versionId));
  const previous = others.find((version) => isOlder(version, current)) ?? null;
  const latest = others[0] && isOlder(current, others[0]) ? others[0] : null;
  return { versions: others, previous, latest };
}
