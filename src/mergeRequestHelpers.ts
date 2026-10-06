import type { CommitFile } from "./App";
import type { MrDetail, MrDiffRefs, MrDiffVersion, MrDiffVersionInfo } from "./mergeRequestTypes";
import { tx, translateNativeMessage } from "./i18n.ts";

export function sameMrRefs(left: MrDiffRefs | null | undefined, right: MrDiffRefs | null | undefined): boolean {
  return !!left && !!right && left.baseSha === right.baseSha && left.startSha === right.startSha && left.headSha === right.headSha;
}

export function reviewVersion(detail: MrDetail): MrDiffVersionInfo | null {
  return detail.diffVersions.find((version) => sameMrRefs(version.refs, detail.diffRefs)) ?? null;
}

export function mrVersionChanged(pinned: MrDetail | null, latest: MrDetail | null): boolean {
  if (!pinned || !latest) return false;
  return pinned.summary.id !== latest.summary.id || pinned.summary.projectId !== latest.summary.projectId
    || pinned.summary.iid !== latest.summary.iid
    || pinned.summary.sha !== latest.summary.sha || pinned.summary.targetBranch !== latest.summary.targetBranch
    || !sameMrRefs(pinned.diffRefs, latest.diffRefs)
    || reviewVersion(pinned)?.id !== reviewVersion(latest)?.id;
}

/** GitLab version diffs are already hunk text; never read the local checkout here. */
export function mrCommitFiles(version: MrDiffVersion): CommitFile[] {
  return version.files.map((file) => {
    let additions = 0, deletions = 0;
    let inHunk = false;
    for (const line of file.diff.split('\n')) {
      if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && line.startsWith('+')) additions++;
      else if (inHunk && line.startsWith('-')) deletions++;
    }
    const unavailable = file.tooLarge ? tx("GitLab 未提供此文件的差异：内容超过服务器限制")
      : file.collapsed ? tx("GitLab 折叠了此文件的差异，请在网页中展开查看")
      : !file.diff && !file.newFile && !file.deletedFile && !file.renamedFile && file.oldMode === file.newMode
        ? tx("GitLab 未返回此文件的差异内容，请在网页中查看") : undefined;
    return {
      path: file.deletedFile ? file.oldPath : file.newPath,
      status: file.newFile ? 'added' : file.deletedFile ? 'deleted' : file.renamedFile ? 'renamed' : 'modified',
      additions, deletions, diff: file.diff, diffNotice: unavailable,
    };
  });
}

export function mrErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') return translateNativeMessage(error.message);
  return translateNativeMessage(typeof error === 'string' ? error : tx("无法读取合并请求，请重试"));
}
