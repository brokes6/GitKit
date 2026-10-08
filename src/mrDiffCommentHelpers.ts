import type { MrDiffCommentPosition, MrDiffRefs, MrDiscussion } from "./mergeRequestTypes";
import { sameMrRefs } from "./mergeRequestHelpers.ts";

function validLine(line: number | null): boolean {
  return line !== null && Number.isSafeInteger(line) && line > 0;
}

/** Hunk headers and diff metadata do not have a GitLab text-comment position. */
export function isMrCommentableLine(row: { kind: string; oldNo: number | null; newNo: number | null }): boolean {
  if (row.kind === "add") return row.oldNo === null && validLine(row.newNo);
  if (row.kind === "del") return row.newNo === null && validLine(row.oldNo);
  return row.kind === "ctx" && validLine(row.oldNo) && validLine(row.newNo);
}

export function mrCommentLineKey(position: Pick<MrDiffCommentPosition, "oldLine" | "newLine">): string {
  return `${position.oldLine ?? ""}:${position.newLine ?? ""}`;
}

function validPositionLines(position: Pick<MrDiffCommentPosition, "oldLine" | "newLine">): boolean {
  return (position.oldLine !== null || position.newLine !== null)
    && (position.oldLine === null || validLine(position.oldLine))
    && (position.newLine === null || validLine(position.newLine));
}

/** Index once per displayed file/version instead of scanning every thread per row. */
export function mrLineDiscussionIndex(
  discussions: MrDiscussion[],
  refs: MrDiffRefs | null,
  file: Pick<MrDiffCommentPosition, "oldPath" | "newPath">,
): Map<string, MrDiscussion[]> {
  const index = new Map<string, MrDiscussion[]>();
  if (!refs || !refs.baseSha || !refs.startSha || !refs.headSha
    || !file.oldPath || !file.newPath) return index;

  for (const discussion of discussions) {
    const seen = new Set<string>();
    for (const note of discussion.notes) {
      const anchor = note.position;
      if (!anchor || anchor.positionType !== "text" || !sameMrRefs(anchor, refs)
        || anchor.oldPath !== file.oldPath || anchor.newPath !== file.newPath
        || !validPositionLines(anchor)) continue;
      const key = mrCommentLineKey(anchor);
      if (seen.has(key)) continue;
      seen.add(key);
      const threads = index.get(key);
      if (threads) threads.push(discussion);
      else index.set(key, [discussion]);
    }
  }
  return index;
}

/** Keep full threads, but only attach them to the exact displayed diff position. */
export function mrLineDiscussions(
  discussions: MrDiscussion[],
  refs: MrDiffRefs | null,
  position: MrDiffCommentPosition,
): MrDiscussion[] {
  if (!validPositionLines(position)) return [];
  return mrLineDiscussionIndex(discussions, refs, position).get(mrCommentLineKey(position)) ?? [];
}
