import type { Commit } from "./App";

export function commitBranchName(commit: Commit): string {
  return commit.branchLabel ?? commit.branchLabels?.[0] ?? "未归属";
}

/** A logical group is dated by its latest occurrence, without changing the
 * representative's identity or the original author/committer metadata. */
export function commitHistoryDate(commit: Commit): string {
  return (commit.equivalentCommits ?? [commit]).reduce((latest, occurrence) => {
    const date = occurrence.committerDate ?? occurrence.date;
    return Date.parse(date) > Date.parse(latest) ? date : latest;
  }, commit.committerDate ?? commit.date);
}

// Validate that collapsing equivalent commits did not create a cycle, then sort
// the logical history strictly by its latest real committer time. Missing
// parents outside the loaded history window impose no additional constraint.
function orderLogicalHistory(commits: Commit[]): Commit[] | null {
  const byHash = new Map(commits.map((commit) => [commit.fullHash, commit]));
  const childCounts = new Map(commits.map((commit) => [commit.fullHash, 0]));
  const index = new Map(commits.map((commit, i) => [commit.fullHash, i]));
  const times = new Map(commits.map((commit) => [commit.fullHash, Date.parse(commitHistoryDate(commit)) || 0]));
  for (const commit of commits) {
    for (const parent of new Set(commit.parents)) {
      if (byHash.has(parent)) childCounts.set(parent, childCounts.get(parent)! + 1);
    }
  }
  const ready = commits.filter((commit) => childCounts.get(commit.fullHash) === 0);
  let visited = 0;
  while (ready.length) {
    const commit = ready.pop()!;
    visited++;
    for (const parent of new Set(commit.parents)) {
      if (!byHash.has(parent)) continue;
      const count = childCounts.get(parent)! - 1;
      childCounts.set(parent, count);
      if (count === 0) ready.push(byHash.get(parent)!);
    }
  }
  // Equivalent patches can occur in opposite orders on different branches.
  // Their quotient would be cyclic; keep the real history in that case.
  if (visited !== commits.length) return null;
  return [...commits].sort((a, b) => times.get(b.fullHash)! - times.get(a.fullHash)!
    || index.get(a.fullHash)! - index.get(b.fullHash)!);
}

export function orderedEquivalentCommits(commit: Commit): Commit[] {
  const list = commit.equivalentCommits ?? [commit];
  return [...list].sort((a, b) => {
    const at = Date.parse(a.committerDate ?? a.date);
    const bt = Date.parse(b.committerDate ?? b.date);
    return (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
  });
}

export interface SmartMergeResult {
  commits: Commit[];
  mergedGroups: number;
  hiddenCommits: number;
}

// Collapse cherry-picked equivalents into a logical history without pretending
// their Git identities are the same. The patch id proves the diff matches; the
// message + author guard prevents unrelated identical patches from being folded;
// and requiring one commit per branch avoids collapsing re-applied commits on a
// single branch. Parent hashes are mapped to their logical representatives so
// computeGraph can render the compact history as a valid DAG.
export function buildSmartMergeCommits(commits: Commit[], currentBranch: string): SmartMergeResult {
  const buckets = new Map<string, Commit[]>();
  for (const commit of commits) {
    const branch = commit.branchLabel;
    if (!commit.patchId || !branch || commit.isStash || commit.parents.length > 1) continue;
    const key = `${commit.patchId}\u0000${commit.message.trim()}\u0000${commit.author.email.toLocaleLowerCase()}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(commit);
    else buckets.set(key, [commit]);
  }

  const safeGroups = new Map<string, { key: string; occurrences: Commit[]; representative: Commit }>();
  const canonicalHash = new Map<string, string>();
  for (const [key, occurrences] of buckets) {
    if (occurrences.length < 2) continue;
    const branches = occurrences.map(commitBranchName);
    if (branches.some((name) => name === "未归属") || new Set(branches).size !== occurrences.length) continue;
    const representative = occurrences.find((c) =>
      c.branchLabel === currentBranch || c.branchLabels?.includes(currentBranch),
    ) ?? occurrences[0];
    const group = { key, occurrences, representative };
    for (const occurrence of occurrences) {
      safeGroups.set(occurrence.fullHash, group);
      canonicalHash.set(occurrence.fullHash, representative.fullHash);
    }
  }

  if (safeGroups.size === 0) return { commits, mergedGroups: 0, hiddenCommits: 0 };

  const emitted = new Set<string>();
  const result: Commit[] = [];
  let mergedGroups = 0;
  let hiddenCommits = 0;
  for (const commit of commits) {
    const group = safeGroups.get(commit.fullHash);
    if (!group) {
      result.push({ ...commit, parents: [...new Set(commit.parents.map((parent) => canonicalHash.get(parent) ?? parent))] });
      continue;
    }
    if (emitted.has(group.key)) continue;
    emitted.add(group.key);
    mergedGroups++;
    hiddenCommits += group.occurrences.length - 1;

    const representative = group.representative;
    const occurrenceHashes = new Set(group.occurrences.map((c) => c.fullHash));
    const parents = new Set<string>();
    const tags = new Set<string>();
    const branchLabels = new Set<string>();
    const metadataOrder = [representative, ...group.occurrences.filter((c) => c.fullHash !== representative.fullHash)];
    for (const occurrence of metadataOrder) {
      occurrence.parents.forEach((parent) => {
        const mapped = canonicalHash.get(parent) ?? parent;
        if (mapped !== representative.fullHash && !occurrenceHashes.has(mapped)) parents.add(mapped);
      });
      occurrence.tags?.forEach((tag) => tags.add(tag));
      occurrence.branchLabels?.forEach((branch) => branchLabels.add(branch));
      if (occurrence.branchLabel) branchLabels.add(occurrence.branchLabel);
    }
    result.push({
      ...representative,
      parents: [...parents],
      tags: [...tags],
      branchLabels: [...branchLabels],
      equivalentCommits: orderedEquivalentCommits({ ...representative, equivalentCommits: group.occurrences }),
    });
  }
  const ordered = orderLogicalHistory(result);
  return ordered
    ? { commits: ordered, mergedGroups, hiddenCommits }
    : { commits, mergedGroups: 0, hiddenCommits: 0 };
}
