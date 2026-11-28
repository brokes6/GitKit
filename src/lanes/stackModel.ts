// Stack inference for the lanes workspace.
//
// Git has no notion of a "parent branch" — only commits. A branch's base is
// therefore resolved in two steps:
//   1. an explicit base recorded when the branch was created in this UI wins;
//   2. otherwise walk the branch's first-parent chain and stop at the first
//      commit that is either another local branch's tip (→ stacked on it) or
//      reachable from the trunk (→ based on the trunk).
// The result is a forest rooted at the trunk. Every root→leaf path is a
// "stack" — the unit one lane displays.

export interface LaneCommit {
  hash: string;
  short: string;
  message: string;
  author: string;
  initials: string;
  color: string;
  date: string;
  parents: string[];
}

export interface LaneBranch {
  name: string;
  head: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  isRemote?: boolean;
}

export interface StackNode {
  name: string;
  branch: LaneBranch;
  /** Base branch name; equals the trunk name for roots. */
  parent: string;
  /** Commits owned by this branch, newest first. */
  commits: LaneCommit[];
  /** Commit where this branch leaves its base, when it is in the loaded history. */
  forkHash: string | null;
  /** Commits the base gained after the fork point (null when unknown). */
  behindBase: number | null;
  /** Base came from recorded metadata rather than inference. */
  explicit: boolean;
  /** No own commits on top of the trunk — fresh or already merged. */
  empty: boolean;
  /**
   * Its latest commit is on the trunk (merged). `commits` then lists what it
   * brought in, while `empty` stays true: nothing of it is left to merge.
   */
  merged: boolean;
  children: string[];
  depth: number;
  updated: number;
}

export interface Stack {
  /** Leaf branch name. */
  id: string;
  /** Root → leaf. */
  chain: string[];
  updated: number;
}

/** One "branch B was merged into T" fact, found from a merge commit. */
export interface MergeRecord {
  /** Branch that made the merge commit (trunk or a branch owning it). */
  into: string;
  /** The merge commit, on `into`'s own history. */
  hash: string;
  date: string;
  /** The commit of the merged branch that went in (its second parent). */
  commit: string;
  /** `commit` is not the branch's tip: the branch moved on after this merge. */
  stale: boolean;
}

export interface StackModel {
  trunk: string;
  trunkBranch?: LaneBranch;
  trunkCommits: LaneCommit[];
  nodes: Map<string, StackNode>;
  roots: string[];
  stacks: Stack[];
  /** Per branch: where it was merged, oldest merge first. */
  merges: Map<string, MergeRecord[]>;
  /**
   * Long-lived branches that collect merges (e.g. test → pre → master), in the
   * order work usually reaches them; the trunk is always last.
   */
  longLived: string[];
}

const TRUNK_NAMES = ["main", "master", "trunk", "develop"];
const OWN_COMMIT_LIMIT = 500;

export function pickTrunk(branches: LaneBranch[], preferred?: string): string {
  const local = branches.filter((b) => !b.isRemote);
  if (preferred && local.some((b) => b.name === preferred)) return preferred;
  for (const name of TRUNK_NAMES) if (local.some((b) => b.name === name)) return name;
  return local.find((b) => b.current)?.name ?? local[0]?.name ?? "main";
}

export interface StackOptions {
  /** User-chosen trunk; ignored when no such local branch exists. */
  trunk?: string;
  /** User-given long-lived branches in promotion order; empty = detect from merges. */
  longLived?: string[];
}

export function buildStackModel(
  branches: LaneBranch[],
  commits: LaneCommit[],
  explicitBases: Record<string, string> = {},
  options: StackOptions = {},
): StackModel {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const local = branches.filter((b) => !b.isRemote);
  const trunk = pickTrunk(branches, options.trunk);
  const trunkBranch = local.find((b) => b.name === trunk);
  const branchByName = new Map(local.map((b) => [b.name, b]));
  const time = (hash: string | undefined) => {
    const c = hash ? byHash.get(hash) : undefined;
    return c ? new Date(c.date).getTime() || 0 : 0;
  };

  // Everything reachable from the trunk (and its upstream, which may be ahead
  // after a fetch) counts as "already on the trunk".
  const trunkSet = new Set<string>();
  const trunkHeads = [trunkBranch?.head];
  if (trunkBranch?.upstream) trunkHeads.push(branches.find((b) => b.isRemote && b.name === trunkBranch.upstream)?.head);
  const queue = trunkHeads.filter((h): h is string => !!h);
  while (queue.length) {
    const h = queue.pop()!;
    if (trunkSet.has(h)) continue;
    const c = byHash.get(h);
    if (!c) continue;
    trunkSet.add(h);
    for (const p of c.parents) if (!trunkSet.has(p)) queue.push(p);
  }

  // Long enough that fork points of visible branches usually land inside it.
  const trunkCommits = firstParentChain(trunkBranch?.head, byHash, 1000);

  const tipOwners = new Map<string, string[]>();
  for (const b of local) {
    if (b.name === trunk || !b.head) continue;
    const list = tipOwners.get(b.head) ?? [];
    list.push(b.name);
    tipOwners.set(b.head, list);
  }

  const nodes = new Map<string, StackNode>();
  for (const b of local) {
    if (b.name === trunk) continue;
    const explicitBase = explicitBases[b.name];
    const base = explicitBase && (explicitBase === trunk || branchByName.has(explicitBase)) ? explicitBase : undefined;
    const walk = base && base !== trunk
      ? walkToExplicitBase(b, branchByName.get(base)!, byHash, trunkSet)
      : walkInferred(b, byHash, trunkSet, tipOwners, explicitBases);
    const parent = base ?? walk.parent ?? trunk;
    nodes.set(b.name, {
      name: b.name, branch: b, parent,
      commits: walk.own, forkHash: walk.fork,
      behindBase: null, explicit: !!base,
      empty: walk.own.length === 0 && parent === trunk,
      merged: false,
      children: [], depth: 0,
      updated: time(b.head),
    });
  }

  // Break any cycle introduced by stale explicit metadata.
  for (const node of nodes.values()) {
    const seen = new Set([node.name]);
    let p = node.parent;
    while (p !== trunk && nodes.has(p)) {
      if (seen.has(p)) { node.parent = trunk; node.explicit = false; break; }
      seen.add(p);
      p = nodes.get(p)!.parent;
    }
    if (node.parent !== trunk && !nodes.has(node.parent)) node.parent = trunk;
  }

  for (const node of nodes.values()) {
    if (node.parent !== trunk) nodes.get(node.parent)!.children.push(node.name);
    const baseHead = node.parent === trunk ? trunkBranch?.head : nodes.get(node.parent)?.branch.head;
    node.behindBase = countUntil(baseHead, node.forkHash, byHash);
  }
  const roots: string[] = [];
  for (const node of nodes.values()) {
    let depth = 0, p = node.parent;
    while (p !== trunk && nodes.has(p)) { depth++; p = nodes.get(p)!.parent; }
    node.depth = depth;
    if (node.parent === trunk) roots.push(node.name);
    node.children.sort((a, b) => nodes.get(b)!.updated - nodes.get(a)!.updated);
  }

  const stacks: Stack[] = [];
  for (const node of nodes.values()) {
    if (node.children.length) continue;
    const chain = [node.name];
    let p = node.parent;
    while (p !== trunk && nodes.has(p)) { chain.unshift(p); p = nodes.get(p)!.parent; }
    stacks.push({ id: node.name, chain, updated: Math.max(...chain.map((n) => nodes.get(n)!.updated)) });
  }
  const rank = (s: Stack) => {
    const leaf = nodes.get(s.id)!;
    if (s.chain.some((n) => nodes.get(n)!.branch.current)) return 0;
    return leaf.empty && s.chain.length === 1 ? 2 : 1;
  };
  stacks.sort((a, b) => rank(a) - rank(b) || b.updated - a.updated || a.id.localeCompare(b.id));
  roots.sort((a, b) => Number(nodes.get(a)!.empty) - Number(nodes.get(b)!.empty)
    || nodes.get(b)!.updated - nodes.get(a)!.updated);

  const facts = mergeFacts(trunk, trunkCommits, nodes, byHash, branches);
  const { merges } = facts;
  const given = (options.longLived ?? []).filter((n) => n !== trunk && nodes.has(n));
  const longLived = given.length ? [...given, trunk] : facts.longLived;
  const trunkFp = new Set(trunkCommits.map((c) => c.hash));
  for (const node of nodes.values()) {
    node.merged = !!merges.get(node.name)?.some((m) => m.into === trunk && !m.stale);
    // A merged branch's tip is reachable from the trunk, so the inferred walk
    // found nothing of its own and stopped at the tip. Walk its first-parent
    // line back to where it left the trunk: those are the commits it brought
    // in (still worth listing), and that is its real fork point.
    if (node.empty && node.forkHash && !trunkFp.has(node.forkHash)) {
      const chain = firstParentChain(node.branch.head, byHash, OWN_COMMIT_LIMIT);
      const at = chain.findIndex((c) => trunkFp.has(c.hash));
      if (at > 0) {
        node.commits = chain.slice(0, at);
        node.forkHash = chain[at].hash;
        node.merged = true; // its content is on the trunk, whichever way it got there
      }
    }
    if (node.merged) node.behindBase = null;
  }

  return { trunk, trunkBranch, trunkCommits, nodes, roots, stacks, merges, longLived };
}

const MERGE_WALK = 200;
const LONG_LIVED_MERGES = 3;

/**
 * Who merged what: every merge commit belongs to the branch whose own history
 * holds it (trunk first-parent history, or a branch's own commits). Walking a
 * branch back from its tip, each commit used as a merge's second parent gives
 * "merged into <owner>" — the newest version per target wins.
 */
function mergeFacts(trunk: string, trunkCommits: LaneCommit[], nodes: Map<string, StackNode>, byHash: Map<string, LaneCommit>, branches: LaneBranch[]) {
  const owner = new Map<string, string>();
  for (const c of trunkCommits) owner.set(c.hash, trunk);
  for (const node of nodes.values()) for (const c of node.commits) if (!owner.has(c.hash)) owner.set(c.hash, node.name);
  const trunkFp = new Set(trunkCommits.map((c) => c.hash));

  // A server-side merge can be ahead of the local target. Attribute just
  // the fetched first-parent extension, leaving the local lane at its own tip.
  const tracking = new Map(branches.filter(b => b.isRemote).map(b => [b.name, b.head]));
  for (const branch of branches) {
    const tip = branch.upstream && tracking.get(branch.upstream);
    if (branch.isRemote || !tip || tip === branch.head || branch.ahead > 0) continue;
    const extension = firstParentChain(tip, byHash, 1000);
    const at = extension.findIndex(c => c.hash === branch.head);
    if (at < 0) continue;
    for (const commit of extension.slice(0, at)) {
      if (!owner.has(commit.hash)) owner.set(commit.hash, branch.name);
      if (branch.name === trunk) trunkFp.add(commit.hash);
    }
  }

  const mergedBy = new Map<string, LaneCommit[]>();
  const intake = new Map<string, Set<string>>();
  for (const [hash, into] of owner) {
    const c = byHash.get(hash);
    if (!c || c.parents.length < 2) continue;
    for (const p of c.parents.slice(1)) {
      const list = mergedBy.get(p) ?? [];
      list.push(c);
      mergedBy.set(p, list);
      // Merges of the trunk itself (keeping a branch up to date) don't make it long-lived.
      if (!trunkFp.has(p)) {
        const set = intake.get(into) ?? new Set();
        set.add(p);
        intake.set(into, set);
      }
    }
  }

  const merges = new Map<string, MergeRecord[]>();
  for (const node of nodes.values()) {
    const found = new Map<string, MergeRecord>();
    let h: string | undefined = node.branch.head;
    for (let i = 0; h && i < MERGE_WALK && (i === 0 || !trunkFp.has(h)); i++) {
      for (const m of mergedBy.get(h) ?? []) {
        const into = owner.get(m.hash)!;
        if (into !== node.name && !found.has(into)) found.set(into, { into, hash: m.hash, date: m.date, commit: h, stale: i > 0 });
      }
      h = byHash.get(h)?.parents[0];
    }
    if (found.size) merges.set(node.name, [...found.values()].sort((a, b) => time(a.date) - time(b.date)));
  }

  // Long-lived: branches (besides the trunk) that took in several other branches.
  const candidates = [...nodes.keys()].filter((name) => (intake.get(name)?.size ?? 0) >= LONG_LIVED_MERGES);
  // Order them by where they usually come in a branch's merge sequence.
  const score = new Map<string, { sum: number; n: number }>();
  for (const list of merges.values()) {
    const seq = list.filter((m) => candidates.includes(m.into));
    seq.forEach((m, i) => {
      const s = score.get(m.into) ?? { sum: 0, n: 0 };
      s.sum += seq.length > 1 ? i / (seq.length - 1) : 0.5;
      s.n++;
      score.set(m.into, s);
    });
  }
  const avg = (name: string) => { const s = score.get(name); return s ? s.sum / s.n : 0.5; };
  candidates.sort((a, b) => avg(a) - avg(b) || a.localeCompare(b));
  return { merges, longLived: [...candidates, trunk] };
}

function time(date: string): number {
  return new Date(date).getTime() || 0;
}

interface Walk { own: LaneCommit[]; fork: string | null; parent?: string }

function walkInferred(
  branch: LaneBranch, byHash: Map<string, LaneCommit>, trunkSet: Set<string>, tipOwners: Map<string, string[]>,
  explicitBases: Record<string, string>,
): Walk {
  const own: LaneCommit[] = [];
  let h: string | undefined = branch.head;
  const seen = new Set<string>();
  while (h && !seen.has(h) && own.length < OWN_COMMIT_LIMIT) {
    seen.add(h);
    if (trunkSet.has(h)) return { own, fork: h };
    const owners = tipOwners.get(h)?.filter((n) => n !== branch.name && explicitBases[n] !== branch.name) ?? [];
    if (own.length > 0) {
      if (owners.length) return { own, fork: h, parent: owners[0] };
    } else {
      // Two branches on the same tip: without metadata, stack the later name
      // on the earlier one so they never both claim the same commits.
      const earlier = owners.filter((n) => n.localeCompare(branch.name) < 0).sort()[0];
      if (earlier) return { own, fork: h, parent: earlier };
    }
    const c = byHash.get(h);
    if (!c) break;
    own.push(c);
    h = c.parents[0];
  }
  return { own, fork: null };
}

function walkToExplicitBase(
  branch: LaneBranch, base: LaneBranch, byHash: Map<string, LaneCommit>, trunkSet: Set<string>,
): Walk {
  const baseSet = new Set(firstParentChain(base.head, byHash, 4000).map((c) => c.hash));
  const own: LaneCommit[] = [];
  let h: string | undefined = branch.head;
  const seen = new Set<string>();
  while (h && !seen.has(h) && own.length < OWN_COMMIT_LIMIT) {
    seen.add(h);
    if (baseSet.has(h) || trunkSet.has(h)) return { own, fork: h };
    const c = byHash.get(h);
    if (!c) break;
    own.push(c);
    h = c.parents[0];
  }
  return { own, fork: null };
}

function firstParentChain(head: string | undefined, byHash: Map<string, LaneCommit>, limit: number): LaneCommit[] {
  const out: LaneCommit[] = [];
  const seen = new Set<string>();
  let h = head;
  while (h && !seen.has(h) && out.length < limit) {
    seen.add(h);
    const c = byHash.get(h);
    if (!c) break;
    out.push(c);
    h = c.parents[0];
  }
  return out;
}

function countUntil(head: string | undefined, target: string | null, byHash: Map<string, LaneCommit>): number | null {
  if (!head || !target) return null;
  let n = 0;
  const seen = new Set<string>();
  let h: string | undefined = head;
  while (h && !seen.has(h) && n < 5000) {
    if (h === target) return n;
    seen.add(h);
    const c = byHash.get(h);
    if (!c) return null;
    n++;
    h = c.parents[0];
  }
  return null;
}

/** Depth-first rows for the branch tree (trunk first). */
export function treeRows(model: StackModel): { name: string; depth: number }[] {
  const rows: { name: string; depth: number }[] = [];
  const visit = (name: string, depth: number) => {
    rows.push({ name, depth });
    for (const child of model.nodes.get(name)?.children ?? []) visit(child, depth + 1);
  };
  for (const root of model.roots) visit(root, 1);
  return rows;
}

/** The stack that best shows `branch`: the newest one whose chain contains it. */
export function stackFor(model: StackModel, branch: string): Stack | undefined {
  return model.stacks.filter((s) => s.chain.includes(branch)).sort((a, b) => b.updated - a.updated)[0];
}
