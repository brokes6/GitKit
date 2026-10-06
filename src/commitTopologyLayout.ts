import type { Commit, GraphRowInfo } from "./App";

export const TOPOLOGY_COLUMN_STEP = 168;
export const TOPOLOGY_LANE_STEP = 144;
export const TOPOLOGY_PADDING = 104;

export interface CommitTopologyNode {
  commit: Commit;
  lane: number;
  column: number;
  x: number;
  y: number;
  color: string;
}

export interface CommitTopologyEdge {
  parent: CommitTopologyNode;
  child: CommitTopologyNode;
  color: string;
  /** Position in the real Git parent list; zero is the first-parent backbone. */
  parentIndex: number;
}

export interface CommitTopology {
  nodes: CommitTopologyNode[];
  edges: CommitTopologyEdge[];
  laneCount: number;
  laneSpacing: number;
  width: number;
  height: number;
  omittedParentCount: number;
}

/** Lay out the actual, newest-first Git history. Branch lanes come from the
 * existing graph layout; columns preserve ancestry and separate disconnected
 * commits that reuse a lane. Missing or reversed parents are never inferred. */
export function buildCommitTopology(commits: readonly Commit[], graphRows: readonly GraphRowInfo[]): CommitTopology {
  const indexByHash = new Map(commits.map((commit, index) => [commit.fullHash, index]));
  const visibleParents: { index: number; parentIndex: number }[][] = [];
  let omittedParentCount = 0;
  let maxRefRows = 0;

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index];
    const parents: { index: number; parentIndex: number }[] = [];
    const seen = new Set<string>();
    for (let parentIndex = 0; parentIndex < commit.parents.length; parentIndex++) {
      // Stash index/untracked parents are implementation objects, not commits
      // in the user's branch topology. git_log normally removes them already.
      if (commit.isStash && parentIndex > 0) continue;
      const parent = commit.parents[parentIndex];
      if (seen.has(parent)) continue;
      seen.add(parent);
      const visibleIndex = indexByHash.get(parent);
      if (visibleIndex === undefined || visibleIndex <= index) {
        omittedParentCount++;
        continue;
      }
      parents.push({ index: visibleIndex, parentIndex });
    }
    visibleParents.push(parents);
    const refCount = new Set(commit.tags ?? []).size;
    maxRefRows = Math.max(maxRefRows, Math.min(refCount, 3) + Number(refCount > 3));
  }

  // Ref badges sit above the node. Reserve more room between lanes when a
  // commit has three badges or the capped list's additional-ref indicator.
  const laneSpacing = TOPOLOGY_LANE_STEP + Math.max(0, maxRefRows - 2) * 20;
  const nodes: CommitTopologyNode[] = new Array(commits.length);
  const lastColumnByLane = new Map<number, number>();
  let maxColumn = 0;
  let laneCount = 0;

  for (let index = commits.length - 1; index >= 0; index--) {
    const row = graphRows[index];
    const lane = row?.dotLane ?? 0;
    const parentColumn = visibleParents[index].reduce((column, parent) => Math.max(column, nodes[parent.index].column + 1), 0);
    const column = Math.max(parentColumn, (lastColumnByLane.get(lane) ?? -1) + 1);
    nodes[index] = {
      commit: commits[index],
      lane,
      column,
      x: TOPOLOGY_PADDING + column * TOPOLOGY_COLUMN_STEP,
      y: TOPOLOGY_PADDING + lane * laneSpacing,
      color: row?.colors?.dot ?? "#8A857C",
    };
    lastColumnByLane.set(lane, column);
    maxColumn = Math.max(maxColumn, column);
    laneCount = Math.max(laneCount, lane + 1);
  }

  const edges: CommitTopologyEdge[] = [];
  for (let index = 0; index < commits.length; index++) {
    for (const parent of visibleParents[index]) {
      const parentNode = nodes[parent.index];
      edges.push({ parent: parentNode, child: nodes[index], color: parentNode.color, parentIndex: parent.parentIndex });
    }
  }

  return {
    nodes,
    edges,
    laneCount,
    laneSpacing,
    width: TOPOLOGY_PADDING * 2 + maxColumn * TOPOLOGY_COLUMN_STEP,
    height: TOPOLOGY_PADDING * 2 + Math.max(0, laneCount - 1) * laneSpacing,
    omittedParentCount,
  };
}
