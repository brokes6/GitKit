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

- Open or clone repositories and switch between them from the project sidebar.
- Open **Workbench** for a multi-project overview of conflicts, unfinished Git operations, working changes, commits to push, known upstream updates, and check errors. Filter or search projects and jump into their existing workflows. Local refreshes are read-only; remote checks and confirmed synchronization remain separate actions. GitKit remembers the last page you used.
- Browse a graph with local and remote branch context, tags, authors, and commit diffs. Pin, hide, or focus branches; names such as `feature/*` are grouped into folders.
- Turn on **Smart Merge** to collapse eligible identical changes into one display row. Expand the row to inspect its original commits. This changes the view, never Git history.
- Search loaded commits by message, author, branch, or hash with `⌘ F` / `Ctrl F`, arrow keys, Enter, and Esc.

### Changes and synchronization

- Stage or unstage whole files in Git's real index. Preview HEAD → index and index → working tree separately; a file with both kinds of changes appears in both lists. Commits use the reviewed index and preserve later working-tree edits, including changes staged outside GitKit. A changed index or HEAD requires reviewing the refreshed state before retrying. Commit identities and drafts remain per project.
- Watch working tree changes, including Git metadata in linked worktrees, and discard changes with confirmation.
- Create, check out, rename, and delete branches. GitKit warns when another worktree owns a branch and offers choices when switching with uncommitted changes.
- Merge a branch into the current branch after reviewing the direction, changed files, and predicted conflicts. Starting a merge requires a clean working tree and index. Paused merges remain visible after switching projects or reopening the app; resolve and stage conflicts, then continue with a reviewed message or abort. Kaleidoscope can help resolve conflicts when available.
- Fetch, pull, and push with progress feedback; fetch and pull can be cancelled. Fetch can fast-forward safe local tracking branches and report skipped ones.
- Cherry-pick with a preflight conflict check. Paused Cherry-pick operations use the same floating conflict bar, real staging, and optional Kaleidoscope workflow as merges. Review staged changes before continuing; Git preserves the original author and message. Continue or abort works after switching projects or reopening the app, including sequences started in another tool. Aborting restores the state before the entire sequence began.
- Create and inspect stashes, and create or push tags.
- Schedule a daily check of open repositories, optionally skipping weekends. Checks update remote-tracking information; you choose whether to synchronize. An interrupted check can resume after sleep or on the next launch.

### Accounts and desktop preferences

- Configure multiple GitHub accounts and a GitLab integration, including self-hosted GitLab instances. Review token expiry and permissions when the provider supplies them.
- Preview merge conflicts before creating a GitHub pull request or GitLab merge request. Create a GitHub repository and add a remote when a local repository has none.
- Choose English or Simplified Chinese, six color palettes, and light, dark, or system appearance.
- Save multiple commit identities and per-project choices without changing global Git identity settings. GitKit also remembers window geometry, respects reduced-motion preferences, checks Git / Git LFS dependencies, and supports signed in-app updates.

## Screenshots

Captured from the local `npm run tauri dev` build with the GitKit repository open. The app language is available under **Settings → Language**.

| Working tree | Commit diff |
| --- | --- |
| ![Working tree changes and commit controls](docs/screenshots/changes-commit.jpg) | ![Commit files and code diff](docs/screenshots/commit-detail-diff.jpg) |

| Search | Appearance |
| --- | --- |
| ![Search commits by message](docs/screenshots/commit-search.jpg) | ![Six theme palettes and appearance modes](docs/screenshots/settings-themes.jpg) |

| Branches | Tags |
| --- | --- |
| ![Create a new branch](docs/screenshots/new-branch.jpg) | ![Inspect and create tags](docs/screenshots/create-tag.jpg) |

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

- Conflict editing uses external tools; there is no built-in conflict editor. Continue and abort actions support merges and Cherry-pick. Empty staged changes or messages, externally rewritten messages, and special sequences such as `--no-commit` require an explicit decision in the terminal; supported paused sequences can still be aborted. Paused revert and rebase operations are identified but must be completed in the terminal.
- Commit search covers the history currently loaded for the repository (up to 400 commits) and displays up to 80 matches.
- Provider tokens are currently stored in the local WebView's `localStorage`, rather than the system keychain. Grant only the permissions you need.
- Background checks run while the app is running. Sleep suspends an active check; the app retries eligible checks after waking or on a later launch.

## License

[Apache-2.0](LICENSE)
