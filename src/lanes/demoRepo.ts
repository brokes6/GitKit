import type { LaneBranch, LaneCommit } from "./stackModel";

// A small synthetic repository so the lanes workspace can be previewed in a
// plain browser (`npm run dev`) where the Tauri backend is unavailable.

const AUTHORS = [
  { author: "Lin Qiao", initials: "LQ", color: "#5E78C7" },
  { author: "Sam Ortiz", initials: "SO", color: "#4F8A6B" },
  { author: "Mei Tan", initials: "MT", color: "#B78338" },
];

let seq = 0;
const now = Date.now();
function hash(): string {
  seq++;
  let x = (seq * 2654435761) >>> 0, out = "";
  for (let i = 0; i < 5; i++) { x = (x * 1103515245 + 12345) >>> 0; out += x.toString(16).padStart(8, "0"); }
  return out.slice(0, 40);
}

export interface DemoRepo { branches: LaneBranch[]; commits: LaneCommit[]; changes: number }

export function createDemoRepo(): DemoRepo {
  seq = 0;
  const commits: LaneCommit[] = [];
  let minutes = 60 * 24 * 9;
  const add = (parent: string | undefined, message: string, author = 0): string => {
    const h = hash();
    minutes -= 37 + (seq % 5) * 23;
    commits.push({ hash: h, short: h.slice(0, 7), message, ...AUTHORS[author % AUTHORS.length],
      date: new Date(now - minutes * 60000).toISOString(), parents: parent ? [parent] : [] });
    return h;
  };
  const line = (from: string | undefined, messages: string[], author = 0) => {
    let h = from;
    messages.forEach((m, i) => { h = add(h, m, author + i); });
    return h!;
  };

  const m1 = line(undefined, ["Initial commit", "Set up Tauri shell", "Add git log reader", "Render commit timeline"]);
  const docs = line(m1, ["docs: describe local setup"], 2);
  const m2 = line(m1, ["Add branch sidebar", "Persist window state", "Stage and commit files"], 1);
  const auth = line(m2, ["auth: token storage", "auth: keychain bridge", "auth: sign-in screen", "auth: handle expired tokens"]);
  const oauth = line(auth, ["oauth: device flow", "oauth: poll for approval", "oauth: refresh tokens"], 1);
  const oauthUi = line(oauth, ["oauth-ui: account picker", "oauth-ui: connected badge"], 2);
  const m3 = line(m2, ["Speed up history paging", "Fix diff wrapping"], 2);
  const lanes = line(m3, ["lanes: stack model", "lanes: lane layout", "lanes: capsule switcher", "lanes: branch tree", "lanes: base strip"]);
  const dock = line(lanes, ["dock: segmented bar", "dock: create branch popover", "dock: project menu"], 1);
  const scroll = line(m3, ["fix: virtualize long diffs", "fix: scroll restoration on refresh"], 2);
  const main = line(m3, ["Bump dependencies"], 0);

  const branch = (name: string, head: string, extra: Partial<LaneBranch> = {}): LaneBranch =>
    ({ name, head, current: false, ahead: 0, behind: 0, upstream: `origin/${name}`, ...extra });
  return {
    commits: commits.reverse(),
    changes: 4,
    branches: [
      branch("main", main, { behind: 2 }),
      branch("docs/setup", docs, { ahead: 1 }),
      branch("auth/tokens", auth),
      branch("auth/oauth", oauth, { ahead: 3, upstream: undefined }),
      branch("auth/oauth-ui", oauthUi, { upstream: undefined }),
      branch("feat/lanes", lanes, { ahead: 2 }),
      branch("feat/lanes-dock", dock, { current: true, upstream: undefined }),
      branch("fix/scroll", scroll),
    ],
  };
}

export function demoCommit(parent: string, message: string): LaneCommit {
  const h = hash();
  return { hash: h, short: h.slice(0, 7), message, ...AUTHORS[0], date: new Date().toISOString(), parents: [parent] };
}
