// Presentation helpers for lane commit rows: a readable merge line and a short date.

export interface MergeLabel {
  source: string;
  /** Missing when the message names no target ("Merge branch 'x'"): it merged into the branch itself. */
  target?: string;
}

const PATTERNS: RegExp[] = [
  // Merge branch 'x' into 'y' · Merge branch 'x' into y · Merge branch 'x' of github.com:a/b into y
  /^Merge (?:remote-tracking )?branch(?:es)? '([^']+)'(?: of \S+)?(?: into '?([^'\s]+)'?)?/,
  // Merge pull request #12 from owner/x
  /^Merge pull request #\d+ from [^/\s]+\/(\S+)/,
  // Merge x into y
  /^Merge (\S+) into '?([^'\s]+)'?/,
];

/** "Merge branch 'feature/x' into 'master'" → { source: "feature/x", target: "master" }. */
export function parseMerge(message: string): MergeLabel | null {
  const first = message.split("\n", 1)[0].trim();
  for (const re of PATTERNS) {
    const m = re.exec(first);
    if (!m) continue;
    const source = m[1].replace(/^(?:origin|upstream)\//, "");
    const target = m[2]?.replace(/^(?:origin|upstream)\//, "");
    return target ? { source, target } : { source };
  }
  return null;
}

/** Today → "14:05"; this year → "11月19日" / "Nov 19"; older → "2025/11/19". */
export function shortDate(iso: string, now = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return d.toLocaleDateString(locale, { year: "numeric", month: "numeric", day: "numeric" });
}
