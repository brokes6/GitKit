<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="GitKit icon" width="88" />
</p>

<h1 align="center">GitKit</h1>

<p align="center">A desktop workspace for repositories, branches, commit history, and code changes.</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/brokes6/gitkit/releases">Download</a> ·
  <a href="HANDOFF.md">Architecture</a> ·
  <a href="RELEASE.md">Release guide</a>
</p>

GitKit is built with **Tauri v2, Rust, React, and TypeScript**. It uses the system `git`, so existing SSH keys and Git credential helpers can work with it. GitHub and GitLab platform actions require a configured account or token. The interface supports English and Simplified Chinese.

![GitKit workspace with repositories, branches, history, and status](docs/screenshots/main-history-graph.jpg)

## Highlights

| Explore | Make changes | Collaborate |
| --- | --- | --- |
| Browse the commit graph, inspect diffs, focus branches, and search history. | Review working tree changes, stage and commit files, manage branches, stashes, and tags. | Fetch, pull, and push; create GitHub pull requests and GitLab merge requests. |

### Repositories and history

- Open repositories or ordinary project folders, or clone repositories, and switch between projects from the sidebar. For a folder without Git, click **Push** and confirm initialization; existing files stay in place. Click Push again to connect a new remote repository.
- Open **Workbench** for a compact project overview that defaults to projects needing attention: conflicts, unfinished Git operations, working changes, commits to push, known upstream updates, and check errors. Filter or search projects and jump into their workflows. The top controls refresh local status and activity across all projects, check remote updates, or add a project. Local refreshes are read-only; synchronization remains a separate action. GitKit remembers the last page you used.
- View the last **12 months of local commit activity** across all added projects, matching author emails against every commit identity configured in Settings. Other authors are excluded; without configured identities, the calendar shows zero activity. The calendar uses committer dates in your local time zone, includes unpushed commits, and counts the same commit ID once across clones and worktrees. Select a date to see its projects and open a project's history. Failed reads are marked as incomplete statistics. No GitHub account is required.
- Browse a graph with local and remote branch context, tags, authors, and commit diffs. Pin, hide, or focus branches; names such as `feature/*` are grouped into folders.
- Expand file diffs for more room, syntax highlighting, and navigation between files and changed sections.
- Open **File history** from a commit's file diff to follow changes, including renames. Choose history up to the selected commit or the current branch's latest version, inspect each change, and switch to **Blame** to see line authorship and open its source commit.
- Turn on **Smart Merge** to collapse eligible identical changes into one display row. Expand the row to inspect its original commits. This changes the view, never Git history.
- Search loaded commits by message, author, branch, or hash with `⌘ F` / `Ctrl F`, arrow keys, Enter, and Esc.

### Changes and synchronization

- Stage or unstage whole files in Git's real index. Preview HEAD → index and index → working tree separately; a file with both kinds of changes appears in both lists. Commits use the reviewed index, honor partial staging made outside GitKit, and preserve unstaged and later working-tree edits. A changed index or HEAD requires reviewing the refreshed state before retrying. Commit identities and drafts remain per project.
- Confirm **Undo** to withdraw the latest unpushed commit, keeping its file changes in the working tree and leaving them unstaged. The first commit can also be undone.
- Watch working tree changes, including Git metadata in linked worktrees, and discard changes with confirmation.
- Create, check out, rename, and delete branches. GitKit warns when another worktree owns a branch and offers choices when switching with uncommitted changes.
- Merge a branch into the current branch after reviewing the direction, changed files, and predicted conflicts. Starting a merge requires a clean working tree and index. Paused merges remain visible after switching projects or reopening the app; resolve and stage conflicts, then edit the merge message and continue or abort. A resolved merge can be completed even when its staged content matches HEAD. Kaleidoscope can help resolve conflicts when available.
- Fetch, pull, and push with progress feedback; fetch and pull can be cancelled. Fetch can fast-forward safe local tracking branches and report skipped ones.
- When local and remote history diverge, review the target and remote-only commits before a guarded **Force push**, then type the remote branch name to confirm. GitKit uses `--force-with-lease` and keeps the previous remote tip in a local recovery reference.
- Cherry-pick with a preflight conflict check. Paused Cherry-pick operations use the same floating conflict bar, real staging, and optional Kaleidoscope workflow as merges. Review staged changes before continuing; Git preserves the original author and message. Continue or abort works after switching projects or reopening the app, including sequences started in another tool. Aborting restores the state before the entire sequence began.
- Create and inspect stashes, and create or push tags.
- Schedule a daily check of open repositories, optionally skipping weekends. Checks update remote-tracking information; you choose whether to synchronize. An interrupted check can resume after sleep or on the next launch.

### Accounts and desktop preferences

- Configure multiple GitHub accounts, including GitHub Enterprise, and a GitLab integration for self-hosted instances. Review token expiry and permissions when the provider supplies them.
- Use **Manage tokens** to open the provider's token settings in your browser. GitHub opens the matching page for the token type and selected GitHub.com or Enterprise account; GitLab uses your configured instance.
- Reopening account settings reuses successful token details for five minutes within the app session. Older details stay visible during a background refresh. Refresh manually to request current information; saving a new instance address or token reads its own details.
- Preview merge conflicts before creating a GitHub pull request or GitLab merge request. When a local repository has no remote, create a GitHub or GitLab repository and connect it. If there are no commits yet, commit files locally before pushing.
- Choose English or Simplified Chinese, six color palettes, and light, dark, or system appearance.
- Save multiple commit identities and per-project choices without changing global Git identity settings. GitKit also remembers window geometry, respects reduced-motion preferences, checks Git / Git LFS dependencies, and supports signed in-app updates.

## Screenshots

These screenshots were captured from a Tauri development window running the current source, showing GitKit and a local demo repository. The interface uses Simplified Chinese, and the Token form contains no real credentials. Change the app language under **Settings → Language**.

| Workbench activity | GitHub token settings |
| --- | --- |
| ![Workbench with compact project status and local commit activity](docs/screenshots/workbench-activity.jpg) | ![GitHub Token form with the token management page shortcut and no real credentials](docs/screenshots/settings-github-token.jpg) |

| Undo a commit | Merge preview |
| --- | --- |
| ![Confirm undoing an unpushed commit while keeping its changes in the working tree](docs/screenshots/undo-commit.jpg) | ![Review the merge direction, affected files, and predicted conflicts](docs/screenshots/merge-preview.jpg) |

| Working tree | Expanded code diff |
| --- | --- |
| ![Real staged and unstaged changes with a reviewed commit preview](docs/screenshots/changes-commit.jpg) | ![Expanded syntax-highlighted code diff with file and change navigation](docs/screenshots/commit-detail-diff.jpg) |

**File history and Blame**

![File change history and line authorship with links to source commits](docs/screenshots/file-trace-blame.jpg)

| Search | Appearance |
| --- | --- |
| ![Search commits by message](docs/screenshots/commit-search.jpg) | ![Six theme palettes and appearance modes](docs/screenshots/settings-themes.jpg) |

| Branches | Tags |
| --- | --- |
| ![Preview creating a new branch](docs/screenshots/new-branch.jpg) | ![Preview creating an annotated tag](docs/screenshots/create-tag.jpg) |

| Scheduled checks | Language |
| --- | --- |
| ![Configure scheduled repository checks](docs/screenshots/settings-scheduled-checks.jpg) | ![Choose English or Simplified Chinese](docs/screenshots/settings-language-en.jpg) |

## Run from source

You need system `git`; repositories using Git LFS also need `git-lfs`. Development additionally requires Node.js (the version in [.nvmrc](.nvmrc)), stable Rust and Cargo, and platform build tools: Xcode Command Line Tools on macOS or MSVC, Windows SDK, and WebView2 on Windows.

```bash
npm ci
npm run tauri dev
```

The first run compiles Rust. Vite hot reloads frontend changes, while Tauri rebuilds native changes. `npm run dev` starts only the frontend and cannot provide the Git commands implemented by Tauri.

<details>
<summary>Checks and packaging</summary>

```bash
npx tsc --noEmit
npm run build
node --experimental-strip-types --test tests/*.test.mjs
cargo check --manifest-path src-tauri/Cargo.toml

# Build for the current platform
npm run tauri build
```

The release workflow builds macOS universal and Windows x64 packages for `v*` tags. See [RELEASE.md](RELEASE.md) for signing, notarization, and updater distribution. An update signature is separate from operating-system code signing.

</details>

## Current limits

- Conflict editing uses external tools; there is no built-in conflict editor. Merge and Cherry-pick can be continued or aborted in the app. Paused revert and rebase operations are identified but must be completed in the terminal.
- Cherry-pick with no staged changes, an empty original message, an externally rewritten message, or a special sequence such as `--no-commit` requires an explicit terminal decision. Supported paused sequences can still be aborted.
- Undo eligibility uses known local remote-tracking history. Fetch first to update that information.
- Blame previews the first 2,000 lines of supported text files.
- Commit search covers the history currently loaded for the repository (up to 400 commits) and displays up to 80 matches. The activity calendar reads its own 12-month range and is independent of this limit.
- Activity counts locally reachable history, excluding stashes and commits kept only in the reflog. Known remote history reflects your last fetch; this calendar is not a GitHub account contribution graph.
- Provider tokens are currently stored in the local WebView's `localStorage`, rather than the system keychain. Grant only the permissions you need.
- Background checks run while the app is running. Sleep suspends an active check; the app retries eligible checks after waking or on a later launch.

## License

[Apache-2.0](LICENSE)
