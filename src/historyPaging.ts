export const HISTORY_PAGE_SIZE = 400;
export const HISTORY_MAX = 10000;

/** `git log --max-count` cuts the walk off, so a truncated history always has a
 *  commit whose parent was not returned. A complete one is closed under parents.
 *  Errs toward "truncated": a false positive costs one extra read, a false
 *  negative would hide history. */
export function isHistoryTruncated(commits: ReadonlyArray<{ fullHash: string; parents: readonly string[] }>): boolean {
  if (commits.length === 0) return false;
  const known = new Set(commits.map((commit) => commit.fullHash));
  return commits.some((commit) => commit.parents.some((parent) => !known.has(parent)));
}

/** Next `--max-count`, or null once the cap is reached. */
export function nextHistoryLimit(current: number): number | null {
  const next = current + HISTORY_PAGE_SIZE;
  return next > HISTORY_MAX ? null : next;
}
