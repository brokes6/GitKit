/** A file has independent HEAD → index and index → working-tree changes. */
export interface WorkingFile {
  path: string;
  originalPath?: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";
  staged: boolean;
  hasStaged?: boolean;
  hasUnstaged?: boolean;
  revision?: string;
  diff?: string;
  diffError?: boolean;
  previewKind?: "text" | "binary" | "too_large" | "empty" | "missing";
  previewTruncated?: boolean;
  previewSize?: number;
}

export interface StatusEntry {
  path: string;
  original_path: string | null;
  index_status: string;
  work_status: string;
  staged: boolean;
}

export interface StagingStatus {
  entries: StatusEntry[];
  revision: string;
  full?: boolean;
}

export interface WorkingStatusSnapshot {
  files: WorkingFile[];
  revision: string;
  full: boolean;
}

/** Undefined paths mean a full reconciliation, including external index changes. */
export function shouldRefreshWorkingFile(file: Pick<WorkingFile, "path" | "originalPath">, paths?: readonly string[]): boolean {
  if (!paths) return true;
  return paths.some((scope) => [file.path, file.originalPath].some((candidate) =>
    !!candidate && (candidate === scope || candidate.startsWith(`${scope}/`))));
}

export function workingFileKey(file: Pick<WorkingFile, "path" | "staged">): string {
  return JSON.stringify([file.path, file.staged]);
}

export function workingFileCount(files: WorkingFile[]): number {
  return new Set(files.map((file) => file.path)).size;
}

export function mapWorkingStatus(snapshot: StagingStatus): WorkingFile[] {
  const status = (code: string): WorkingFile["status"] =>
    code === "A" ? "added" : code === "D" ? "deleted" : code === "?" ? "untracked"
      : code === "R" ? "renamed" : "modified";
  return snapshot.entries.flatMap((entry) => {
    const conflict = entry.index_status === "U" || entry.work_status === "U"
      || ["AA", "DD"].includes(entry.index_status + entry.work_status);
    const hasStaged = !conflict && entry.index_status !== " " && entry.index_status !== "?";
    const hasUnstaged = conflict || entry.work_status !== " ";
    const common = {
      path: entry.path, originalPath: entry.index_status === "R" || entry.work_status === "R"
        ? entry.original_path ?? undefined : undefined,
      hasStaged, hasUnstaged, revision: snapshot.revision,
    };
    const rows: WorkingFile[] = [];
    if (hasStaged) rows.push({ ...common, staged: true, status: status(entry.index_status) });
    if (hasUnstaged) rows.push({ ...common, staged: false, status: conflict ? "conflicted" : status(entry.work_status) });
    return rows;
  });
}

export function sameWorking(a: WorkingFile[], b: WorkingFile[]): boolean {
  if (a.length !== b.length) return false;
  const signature = (file: WorkingFile) => JSON.stringify([
    file.status, file.originalPath, file.hasStaged, file.hasUnstaged, file.revision,
  ]);
  const previous = new Map(b.map((file) => [workingFileKey(file), signature(file)]));
  return a.every((file) => previous.get(workingFileKey(file)) === signature(file));
}

export function mergeWorkingPaths(previous: WorkingFile[], paths: string[], fresh: WorkingFile[]): WorkingFile[] {
  const covers = (file: string, changed: string) => file === changed || file.startsWith(`${changed}/`);
  const affected = [...paths, ...fresh.flatMap((file) => file.originalPath ? [file.path, file.originalPath] : [file.path])];
  const merged = new Map(previous
    .filter((file) => !affected.some((changed) => covers(file.path, changed)
      || !!file.originalPath && covers(file.originalPath, changed)))
    .map((file) => [workingFileKey(file), file]));
  for (const file of fresh) merged.set(workingFileKey(file), file);
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path) || Number(b.staged) - Number(a.staged));
}
