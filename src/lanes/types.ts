import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { LaneBranch, LaneCommit, StackModel } from "./stackModel";
import type { LaneView } from "./laneLayout";

export interface LaneProjectRef { id: string; name: string; path: string }
export type LaneMenuItem = "sep" | {
  label: string; icon?: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean;
};
/** An open "new branch" popover: from a branch, or from one commit inside lane `base`. */
export interface CreateRequest {
  base: string;
  slotKey?: number;
  commit?: { hash: string; short: string; message: string };
}

/** What a lane right-click menu is about. */
export type LaneMenuTarget =
  | { kind: "commit"; hash: string; lane: string }
  | { kind: "branch"; branch: string; slotKey: number };

export type LaneBusy = "fetch" | "pull" | "push" | "other" | null;

/** A GitLab merge request / GitHub pull request whose source is a lane's branch. */
export interface LaneRequest {
  /** Platform-global id (GitLab MR id / GitHub PR id). */
  id: number;
  /** Repository-scoped number (iid / PR number). */
  number: number;
  provider: "gitlab" | "github";
  /** `!12` for GitLab, `#12` for GitHub. */
  label: string;
  title: string;
  url: string;
  target: string;
  draft?: boolean;
  /** GitLab pipeline status (success, failed, running, pending, canceled, …). */
  pipeline?: string | null;
  /** GitLab detailed merge status (mergeable, conflict, not_approved, …). */
  mergeStatus?: string | null;
  /** Inbox id when the request is in the GitLab inbox (opens in-app detail). */
  inboxId?: number;
}

/** GitLab inbox state for the dock's merge-request segment. */
export interface LaneInbox {
  configured: boolean;
  /** Items needing attention (review requested / assigned). */
  total: number | null;
  failed: boolean;
  unread: number;
  /** The host renders its inbox popover anchored to this element. */
  anchorRef: { current: HTMLElement | null };
  open: boolean;
  onToggle: () => void;
}

export interface LanesWorkspaceProps {
  theme: "dark" | "light";
  /** CSS custom properties mapped from the host palette. */
  tokens?: CSSProperties;
  demo?: boolean;
  project: LaneProjectRef | null;
  projects: LaneProjectRef[];
  readProjectChanges?: (path: string) => Promise<number | null>;
  status: "none" | "loading" | "error" | "ready";
  error?: string;
  branches: LaneBranch[];
  commits: LaneCommit[];
  changes: number;
  /** Uncommitted files of the checked-out branch, shown at the top of lane 1. */
  working: LaneWorkingFile[];
  busy?: LaneBusy;
  onSelectProject: (project: LaneProjectRef) => void;
  onOpenProject: () => void;
  onCloneProject?: () => void;
  onRetry?: () => void;
  onInitialize?: () => void;
  windowControls?: ReactNode;
  refreshing?: boolean;
  /** Create without switching; the workspace records the base itself. */
  onCreateBranch: (name: string, base: string) => Promise<void>;
  onCheckout: (branch: string) => void;
  onFetch?: () => void;
  onPull?: () => void;
  onPush?: () => void;
  /** Toggle the changes drawer; with a path, open it (if needed) on that file. */
  onOpenChanges: (path?: string) => void;
  /** The changes drawer is showing (the dock's 工作区 segment reads as pressed). */
  changesOpen?: boolean;
  onOpenCommit: (hash: string) => void;
  onOpenSettings: () => void;
  moreActions: LaneMenuItem[];
  /** The host's detail panel (changes, commit or stash); positioned by the host. */
  drawer?: ReactNode;
  /** Branch name → its open merge/pull request, when known. */
  requests?: Record<string, LaneRequest>;
  /** GitLab inbox entry in the dock; omitted when GitLab isn't configured at all. */
  inbox?: LaneInbox;
  /** Open a lane branch's request: in-app detail when in the inbox, else the browser. */
  onOpenRequest?: (branch: string) => void;
  /** Start creating a merge/pull request with `branch` as the source. */
  onCreateRequest?: (branch: string) => void;
  /**
   * A pushed branch was dragged onto another lane: create a merge request from
   * `source` into `target`. The host shows its confirmation dialog first.
   */
  onDropRequest?: (source: string, target: string) => void;
  /** Host items for a commit row's right-click menu (cherry-pick, copy…). */
  commitMenu?: (hash: string, lane: string) => LaneMenuItem[];
  /** Host items for a branch's right-click menu (rename, delete, copy…). */
  branchMenu?: (branch: string) => LaneMenuItem[];
  /** Wording for creating a request on this remote ("创建合并请求" / "创建拉取请求"). */
  createRequestLabel?: string;
}

export interface LaneWorkingFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
}

/** One visible lane. `key` stays with the branch so lanes animate when roles shift. */
export interface Slot { key: number; branch: string; enter?: boolean; exit?: boolean }

/**
 * Identity-stable callbacks shared by every lane (they take the slot key /
 * branch / hash as arguments so lanes can be memoised).
 */
export interface LaneHandlers {
  /** Replace what lane `slotKey` shows with `branch` (pins that position). */
  onPick: (slotKey: number, branch: string) => void;
  /** Open the create-branch popover with `branch` as the base. */
  onCreateFrom: (slotKey: number, branch: string) => void;
  onCheckout: (branch: string) => void;
  onOpenChanges: (path?: string) => void;
  onOpenCommit: (hash: string) => void;
  onHover: (branch: string | null) => void;
  /** Pointer-down on the lane's top bar starts a reorder drag. */
  onDragStart: (event: ReactPointerEvent, slotKey: number) => void;
  /** Mark a lane as focused (default base for the dock's "new branch"). */
  onFocus: (slotKey: number, branch: string) => void;
  /** Branch name → visible lane index, or -1. */
  laneIndex: (branch: string) => number;
  onOpenRequest: (branch: string) => void;
  onCreateRequest: (branch: string) => void;
  /** Bring lane `into` on screen next to `from` and point at merge commit `hash`. */
  onRevealMerge: (from: string, into: string, hash?: string) => void;
  /** Highlight a commit row wherever it is listed (null clears). */
  onHoverCommit: (hash: string | null) => void;
  /** Pointer-down on a lane's branch name: drag it onto another lane to open a merge request. */
  onRequestDragStart: (event: ReactPointerEvent, branch: string) => void;
  /** Right-click on a commit row or a lane's branch. */
  onContextMenu: (event: ReactMouseEvent, target: LaneMenuTarget) => void;
}

/**
 * Props of `Lane` (Lane.tsx). DOM contract used by the link overlay:
 *  - lane root `.lk-lane` carries `data-lane-id={view.id}`
 *  - the lane's card surface `.lk-card` carries `data-lane-card={view.id}`
 *  - the scroll container `.lk-card-body` carries `data-lane-scroll={view.id}`
 *  - every commit row carries `data-commit-hash={full hash}`
 *  - the fork marker (below the lane's own rows) is `.lk-fork[data-fork-anchor={view.id}]`
 */
export interface LaneProps {
  model: StackModel;
  view: LaneView;
  slot: Slot;
  index: number;
  focused: boolean;
  current?: string;
  /** Only lane 1 (the checked-out branch) receives files; others get []. */
  working: LaneWorkingFile[];
  changes: number;
  /** This lane branch's open merge/pull request. */
  request?: LaneRequest;
  /** Label for the "create request" action; omitted when requests aren't available. */
  createRequestLabel?: string;
  /** Whether the branch name can be dragged onto another lane to open a merge request. */
  requestDrag?: "ready" | "unpushed";
  handlers: LaneHandlers;
}
