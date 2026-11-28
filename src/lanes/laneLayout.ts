// Which four branches the lanes show, what rows each lane lists, and the
// relation links (dashed lines) between commits in different lanes.
//
// Lane roles, left to right by default:
//   1. "current" — the checked-out branch (its uncommitted work sits on top)
//   2. "parent"  — the current branch's base (the trunk when it forked from it)
//   3–4. "recent" — the most recently changed other branches
// A user pin (picked from a lane's capsule or the dock tree) replaces the role
// choice at that position until the checked-out branch changes.

import type { LaneBranch, LaneCommit, MergeRecord, StackModel } from "./stackModel";
import type { SlotRule } from "./settings";

export type LaneRole = "current" | "parent" | "recent" | "pinned" | "named";

export interface LaneFork {
  /** Base branch name (the trunk name for trunk-based branches). */
  base: string;
  /** Commit where the branch leaves its base, when known. */
  hash: string | null;
  /** Commits the base gained after the fork (null when unknown). */
  behind: number | null;
  /** Base came from metadata recorded at creation time. */
  explicit: boolean;
}

export interface LaneView {
  /** Branch name; also the lane's identity. */
  id: string;
  role: LaneRole;
  branch: LaneBranch;
  isTrunk: boolean;
  /** Rows to list, newest first: own commits, or the first-parent history for the trunk. */
  rows: LaneCommit[];
  /** Rows not listed because of the row cap. */
  hidden: number;
  /** Where this branch leaves its base; null for the trunk. */
  fork: LaneFork | null;
  /** No commits of its own on top of its base (fresh or already merged). */
  empty: boolean;
  /** Merged into the trunk (its latest commit is on the trunk). */
  merged: boolean;
  /** A long-lived branch that collects merges (test, pre…), or the trunk. */
  longLived: boolean;
  /**
   * Where this branch has been merged. With an environment flow (two or more
   * long-lived branches) every long-lived branch is listed in promotion order,
   * `merge: null` where it hasn't gone yet; otherwise only actual merges.
   */
  flow: LaneFlowStep[];
}

export interface LaneFlowStep {
  into: string;
  merge: MergeRecord | null;
}

export type LaneLinkEnd =
  | { lane: string; hash: string }        // a commit row inside a lane
  | { lane: string; fork: true }          // a lane's fork marker (bottom of its own rows)
  | { lane: string; step: string }        // a lane's "merged into <step>" marker in its header
  | { dock: true };                       // the trunk, drawn as the dock

export interface LaneLink {
  id: string;
  kind: "fork" | "merge";
  from: LaneLinkEnd;
  to: LaneLinkEnd;
}

export const LANE_ROW_CAP = 200;
const TRUNK_MIN_ROWS = 60;

export interface SelectOptions {
  count: number;
  current?: string;
  /** position → branch name chosen by the user. */
  pins?: Record<number, string>;
  /** Extra recency (ms epoch) for branches that have no commits yet, e.g. just created. */
  touched?: Record<string, number>;
  /** One rule per lane (Settings → 分支区域); defaults to current, parent, recent, recent. */
  rules?: SlotRule[];
  /** Merged branches compete for "recent" lanes (default true). */
  includeMerged?: boolean;
}

const DEFAULT_RULES: SlotRule[] = [{ kind: "current" }, { kind: "parent" }, { kind: "recent" }, { kind: "recent" }];

/** Most recent activity for a branch: its tip commit, its latest merge, or a recorded touch. */
export function recency(model: StackModel, name: string, touched: Record<string, number> = {}): number {
  const node = model.nodes.get(name);
  const tip = node?.updated ?? (name === model.trunk ? dateOf(model.trunkCommits[0]) : 0);
  const merged = Math.max(0, ...(model.merges.get(name) ?? []).map((m) => new Date(m.date).getTime() || 0));
  return Math.max(tip, merged, touched[name] ?? 0);
}

export function selectLaneIds(model: StackModel, { count, current, pins = {}, touched = {}, rules = DEFAULT_RULES, includeMerged = true }: SelectOptions): { id: string; role: LaneRole }[] {
  const out: ({ id: string; role: LaneRole } | null)[] = Array.from({ length: count }, () => null);
  const used = new Set<string>();
  const exists = (name: string) => name === model.trunk || model.nodes.has(name);
  const place = (at: number, id: string, role: LaneRole) => { out[at] = { id, role }; used.add(id); };

  for (const [at, id] of Object.entries(pins)) {
    const i = Number(at);
    if (i >= 0 && i < count && exists(id) && !used.has(id)) place(i, id, "pinned");
  }
  // A rule targets its own lane; if a pin holds it, the branch takes the first free lane.
  const fill = (at: number, id: string | undefined, role: LaneRole) => {
    if (!id || used.has(id) || !exists(id)) return false;
    const free = out[at] === null ? at : out.findIndex((slot) => slot === null);
    if (free < 0) return false;
    place(free, id, role);
    return true;
  };
  const cur = current && exists(current) ? current : model.trunk;
  const resolve = (rule: SlotRule): [string | undefined, LaneRole] => {
    switch (rule.kind) {
      case "current": return [cur, "current"];
      case "parent": return cur === model.trunk ? [undefined, "parent"] : [model.nodes.get(cur)?.parent ?? model.trunk, "parent"];
      case "trunk": return [model.trunk, "named"];
      case "named": return [rule.names.find((n) => exists(n) && !used.has(n)), "named"];
      default: return [undefined, "recent"];
    }
  };
  // The current branch is placed first so another rule can't take it; then the rest in lane order.
  const order = rules.slice(0, count).map((rule, at) => ({ rule, at }))
    .sort((a, b) => Number(b.rule.kind === "current") - Number(a.rule.kind === "current"));
  for (const { rule, at } of order) {
    const [id, role] = resolve(rule);
    fill(at, id, role);
  }
  // Every other lane — "recent" rules and rules that found nothing — gets the most recent branches.
  const others = [...model.nodes.keys(), model.trunk]
    .filter((name) => !used.has(name) && (includeMerged || !model.nodes.get(name)?.merged || touched[name]))
    .sort((a, b) => Number(isQuiet(model, a, touched)) - Number(isQuiet(model, b, touched))
      || recency(model, b, touched) - recency(model, a, touched) || a.localeCompare(b));
  for (const name of others) {
    const at = out.findIndex((slot) => slot === null);
    if (at < 0) break;
    place(at, name, "recent");
  }
  return out.filter((slot): slot is { id: string; role: LaneRole } => slot !== null);
}

export function laneView(model: StackModel, id: string, role: LaneRole, minTrunkHashes: string[] = []): LaneView {
  if (id === model.trunk) {
    // Show enough trunk history to reach the deepest fork point on screen.
    const index = new Map(model.trunkCommits.map((c, i) => [c.hash, i]));
    const deepest = Math.max(-1, ...minTrunkHashes.map((h) => index.get(h) ?? -1));
    const take = Math.min(model.trunkCommits.length, Math.max(TRUNK_MIN_ROWS, deepest + 3), LANE_ROW_CAP * 2);
    return {
      id, role, isTrunk: true,
      branch: model.trunkBranch ?? { name: id, head: model.trunkCommits[0]?.hash ?? "", current: false, ahead: 0, behind: 0 },
      rows: model.trunkCommits.slice(0, take), hidden: Math.max(0, model.trunkCommits.length - take),
      fork: null, empty: false, merged: false, longLived: true, flow: [],
    };
  }
  const node = model.nodes.get(id)!;
  const longLived = model.longLived.includes(id);
  return {
    id, role, isTrunk: false, branch: node.branch,
    rows: node.commits.slice(0, LANE_ROW_CAP), hidden: Math.max(0, node.commits.length - LANE_ROW_CAP),
    fork: { base: node.parent, hash: node.forkHash, behind: node.behindBase, explicit: node.explicit },
    empty: node.empty, merged: node.merged, longLived, flow: longLived ? [] : flowOf(model, id),
  };
}

export function flowOf(model: StackModel, id: string): LaneFlowStep[] {
  const merges = model.merges.get(id) ?? [];
  if (model.longLived.length < 2) return merges.map((merge) => ({ into: merge.into, merge }));
  const steps = model.longLived.map((into) => ({ into, merge: merges.find((m) => m.into === into) ?? null }));
  // Merges into other (short-lived) branches come first, as plain steps.
  const extra = merges.filter((m) => !model.longLived.includes(m.into)).map((merge) => ({ into: merge.into, merge }));
  return [...extra, ...steps];
}

export function buildLaneViews(model: StackModel, picks: { id: string; role: LaneRole }[]): LaneView[] {
  const forks = picks.map((p) => model.nodes.get(p.id)?.forkHash).filter((h): h is string => !!h);
  return picks.map((p) => laneView(model, p.id, p.role, forks));
}

/** Dashed relation lines between lanes. */
export function laneLinks(lanes: LaneView[], model: StackModel): LaneLink[] {
  const rowLane = new Map<string, string>();
  for (const lane of lanes) for (const c of lane.rows) if (!rowLane.has(c.hash)) rowLane.set(c.hash, lane.id);
  const shown = new Set(lanes.map((l) => l.id));
  const links: LaneLink[] = [];

  for (const lane of lanes) {
    const fork = lane.fork;
    if (!fork?.hash) continue;
    // Prefer the lane of the base branch itself; otherwise any lane listing that commit.
    const base = lanes.find((l) => l.id === fork.base && l.rows.some((c) => c.hash === fork.hash));
    const target = base?.id ?? rowLane.get(fork.hash);
    if (target && target !== lane.id) {
      links.push({ id: `fork:${lane.id}`, kind: "fork", from: { lane: lane.id, fork: true }, to: { lane: target, hash: fork.hash } });
    } else if (!target && fork.base === model.trunk && !shown.has(model.trunk)) {
      links.push({ id: `fork:${lane.id}`, kind: "fork", from: { lane: lane.id, fork: true }, to: { dock: true } });
    }
  }
  // A branch merged elsewhere: link each merge commit to the lane's header
  // step, unless the merged commit is listed in the lane (the row link below covers it).
  for (const lane of lanes) {
    const own = new Set(lane.rows.map((c) => c.hash));
    for (const step of lane.flow) {
      const m = step.merge;
      if (!m || own.has(m.commit) || rowLane.get(m.hash) !== m.into) continue;
      links.push({ id: `flow:${lane.id}:${m.into}`, kind: "merge", from: { lane: m.into, hash: m.hash }, to: { lane: lane.id, step: m.into } });
    }
  }
  for (const lane of lanes) {
    for (const c of lane.rows) {
      for (const parent of c.parents.slice(1)) {
        const target = rowLane.get(parent);
        if (target && target !== lane.id) {
          links.push({ id: `merge:${c.hash}:${parent}`, kind: "merge", from: { lane: lane.id, hash: c.hash }, to: { lane: target, hash: parent } });
        }
      }
    }
  }
  return links;
}

function isQuiet(model: StackModel, name: string, touched: Record<string, number>): boolean {
  // Branches with nothing to show (sitting on a trunk commit) go last. Merged
  // branches still list their commits, so they compete on recency like any other.
  const node = model.nodes.get(name);
  return !!node && node.commits.length === 0 && !touched[name];
}

function dateOf(c: LaneCommit | undefined): number {
  return c ? new Date(c.date).getTime() || 0 : 0;
}
