/** Remote GitLab data. These types never describe or mutate the local index. */
export interface MrUser { id: number; name: string; username: string }
export interface MrProject { id: number; name: string; pathWithNamespace: string; webUrl: string }
export type MrRole = "author" | "assignee" | "reviewer";
export interface MrSummary {
  id: number;
  projectId: number;
  iid: number;
  title: string;
  state: string;
  description: string | null;
  sourceBranch: string;
  targetBranch: string;
  author: MrUser;
  roles: string[];
  draft: boolean;
  updatedAt: string;
  sha: string | null;
  detailedMergeStatus: string | null;
  webUrl: string;
  pipelineStatus: string | null;
}
export interface MrDiffRefs { baseSha: string; startSha: string; headSha: string }
export interface MrDiffVersionInfo {
  id: number;
  createdAt: string;
  state: string;
  realSize: string | null;
  refs: MrDiffRefs;
}
export interface MrDiffFile {
  oldPath: string;
  newPath: string;
  oldMode: string;
  newMode: string;
  diff: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  tooLarge: boolean | null;
  collapsed: boolean | null;
}
export interface MrDiffVersion extends MrDiffVersionInfo { files: MrDiffFile[]; truncated: boolean }
export interface MrDetail {
  summary: MrSummary;
  description: string;
  pipelineStatus: string | null;
  approvals: {
    readable: boolean;
    approved: boolean | null;
    approvalsRequired: number | null;
    approvalsLeft: number | null;
    approvedBy: MrUser[];
  };
  blockingDiscussionsResolved: boolean | null;
  canMerge: boolean;
  blockedReasons: string[];
  diffRefs: MrDiffRefs | null;
  diffVersions: MrDiffVersionInfo[];
  squashPolicy: string;
  squash: boolean;
  deleteSourceDefault: boolean;
  deleteSourceRequired: boolean;
  deleteSourceAllowed: boolean | null;
}
export interface MrDiscussion {
  id: string;
  individualNote: boolean;
  notes: Array<{
    id: number;
    body: string;
    author: MrUser;
    createdAt: string;
    updatedAt: string;
    system: boolean;
    resolvable: boolean;
    resolved: boolean | null;
  }>;
}
export interface MrMergeResult {
  state: "merged" | "pending" | "uncertain";
  message: string;
  summary: MrSummary | null;
}
export interface MrMergeOptions { reviewedSha: string; squash: boolean; deleteSource: boolean }
export interface MrApiError {
  message: string;
  kind: "unauthorized" | "forbidden" | "not_found" | "rate_limit" | "network" | "timeout" | "server" | "unsupported" | "invalid_config" | "invalid_response" | "blocked" | "conflict" | "stale" | "uncertain";
  retryAfter: number | null;
}
export interface MrSnapshot {
  revision: number;
  epoch: number;
  contextKey: string | null;
  repoPath: string | null;
  user: MrUser | null;
  project: MrProject | null;
  items: MrSummary[];
  total: number;
  newCount: number;
  unseenIids: number[];
  lastCheckedAt: number | null;
  refreshing: boolean;
  stale: boolean;
  error: MrApiError | null;
  persistenceError: string | null;
  selectedDetail: MrDetail | null;
}
export interface MrConfig { accountKey: string; repoPath: string; url: string; token: string; remote: string }
export interface MrVisibility { listOpen: boolean; detailIid: number | null; online: boolean }
