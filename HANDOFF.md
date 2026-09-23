# GitKit — 交接文档 / Handoff

原生 macOS Git 桌面客户端。本文档给接手的开发者(或 AI code agent)一份完整的架构、已实现清单、待办路线图和"怎么加功能"的操作手册。

---

## 1. 技术栈

- **外壳**:Tauri v2(Rust)。原生窗口、系统红黄绿灯(`titleBarStyle: Overlay`)、原生文件夹选择器(`tauri-plugin-dialog`)。
- **前端**:React 18 + TypeScript + Vite + Tailwind CSS v4。单文件 UI(`src/App.tsx`)。
- **Git 后端**:Rust 直接 shell out 调用系统 `git`(不是 libgit2)。**这样能自动复用用户已配置的 SSH key / 凭证 / hooks,认证零配置**,行为与命令行完全一致。
- **主题**:Claude 暖色系(奶油底 + 陶土 coral 强调),亮/暗两套,定义在 `App.tsx` 的 `DARK`/`LIGHT` 对象。

## 2. 运行 / 构建

```bash
# 依赖:macOS + Xcode CLT、Node ≥ 18、Rust(rustup)
cd GitKit
npm install
npm run tauri dev        # 开发(首次编译 Rust 较久)

# 打包 .app(通用二进制)
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build      # 产物在 src-tauri/target/release/bundle/
```

改了 `src-tauri/**`(Rust)必须重启 `tauri dev` 重编;改前端(`src/**`)热更新即可。

## 3. 文件结构

```
GitKit/
├── index.html, vite.config.ts, tsconfig*.json
├── HANDOFF.md, RELEASE.md    # 本交接文档 + 发布/签名/公证手册
├── src/
│   ├── main.tsx              # React 入口
│   ├── App.tsx               # 全部 UI + 状态(~3000 行,单文件)
│   ├── git.ts                # 前端 Git API:invoke 封装 + 图形算法 + 类型映射 + 更新
│   └── styles/               # Tailwind v4 + 主题 CSS 变量
└── src-tauri/
    ├── Cargo.toml            # tauri + dialog/updater/process/window-state + reqwest
    ├── tauri.conf.json       # 窗口 + updater(pubkey/endpoints)+ macOS 签名位
    ├── capabilities/default.json  # 前端可调用的权限白名单(含 updater/process)
    ├── .tauri/gitkit-updater.key(.pub)  # 更新签名密钥;私钥 gitignore,勿提交
    ├── icons/                # App 图标(git-branch 字形)
    └── src/
        ├── main.rs           # 入口
        ├── lib.rs            # 注册插件 + setup(window-state/updater)+ invoke_handler
        └── git.rs            # 所有 Git 命令实现
```

## 4. 数据流

1. 用户点左上角项目名 → "打开新项目" → `pickRepoFolder()`(原生对话框)→ `openRepo(path)` 校验并返回仓库信息 → 加为一个 `real` 项目 Tab。
2. `App` 的 `useEffect`(依赖 `activeProjectId, reloadTick`)对 `real` 项目并行加载:`loadBranches` / `loadRemotes` / `loadHistory` / `loadStatus`。
3. **分支归属**:`attributeBranches(commits, branches)` 从每个分支尖端沿 first-parent 回溯,给每个提交打上 `branchLabel`(当前分支优先)。
4. **图形布局**:`computeGraph(commits)` 用 parent 拓扑算泳道,并按 `branchLabel` 给每条线/节点上色(`branchColor(name)`,与左侧分支圆点同色)。
5. 结果存入 `realData` state,渲染历史时间线;写操作(checkout/cherry-pick/…)完成后 `setReloadTick(n=>n+1)` 触发重载。

演示(mock)项目走硬编码数据(`COMMITS`/`BRANCHES`/`GRAPH_ROWS`/…),用于无仓库时的展示;`activeProject.real` 区分两条路径。

## 5. 后端命令参考(`src-tauri/src/git.rs`)

所有命令签名 `fn(path: String, …) -> Result<T, String>`,失败时把 git 的 stderr 作为错误返回。核心 helper:`run_git(repo, &["arg", …])`。

| 命令 | 作用 |
|---|---|
| `open_repo` | 校验是否 git 仓库,返回 `{path, name, current_branch}` |
| `git_branches` | 本地+远程分支:名称/短&全 hash/upstream/HEAD 标记/ahead-behind/是否远程 |
| `git_remotes` | `git remote -v` → `[{name, url}]`(去重) |
| `git_log` | `--all --topo-order`,自定义分隔符格式,返回 hash/parents/作者/日期/refs/subject/body |
| `git_status` | `--porcelain`,返回每个文件的 index/work 状态 + 是否已暂存 |
| `commit_files` | 某提交的改动文件 + 每文件增删数(numstat + name-status) |
| `commit_file_diff` | 某提交中单个文件的 diff |
| `working_file_diff` | 工作区单个文件 diff(可选 `--cached`) |
| `git_has_changes` | 工作区是否有未提交改动(bool) |
| `git_checkout` | 切换分支 |
| `git_stash_push` | 储藏(含未跟踪 `-u`) |
| `git_cherry_pick` | 遴选提交到当前分支 |

## 6. 前端 API(`src/git.ts`)

- `invoke` 封装:`openRepo` `loadBranches` `loadRemotes` `loadHistory` `loadStatus` `loadCommitFiles` `commitFileDiff` `workingFileDiff` `hasChanges` `checkoutBranch` `stashPush` `cherryPick` `pickRepoFolder`。
- 纯逻辑:
  - `attributeBranches(commits, branches)` — 给提交打 `branchLabel`。
  - `computeGraph(commits)` — 泳道布局 + 上色,返回 `GraphRowInfo[]`。
  - `branchColor(name)` — 分支名 → 稳定颜色(哈希取 `PALETTE`),**侧栏与图共用**。
- 映射:把 Rust 的 snake_case 结构映射成 UI 用的 `Commit`/`Branch`/`WorkingFile`/`Remote`/`CommitFile`(类型在 `App.tsx` 里 `export`)。

## 7. 前端组件(`src/App.tsx`)

`TitleBar`(项目切换弹窗)、`ProjectTabBar`、`ActionBar`(顶部操作按钮)、`Sidebar`(分支树:文件夹分组/置顶/隐藏/远程/储藏)、`CommitRow` + `GraphRowSVG`(提交卡片 + 泳道图)、`CommitDetail`(提交详情 + 遴选按钮)、`ChangesPanel` + `WorkingFileRow` + `WorkingFileDiff`(更改/暂存/diff)、`DiffLine`、`Avatar`、`TagPill`。

**关键实现点:**
- 提交行高度用**确定公式**(内容全单行)+ `content-visibility: auto`,长列表滚动流畅。
- **单时间线**:左侧顶部一个"未提交的更改"item,下面是提交;右侧:选提交→`CommitDetail`,选未提交→`ChangesPanel + WorkingFileDiff`。
- **聚焦/隐藏**:`focusBranch`(单击分支→只看这条,过滤+重算图)、`hiddenBranches`(隐藏的分支从图里也去掉)、`hoverBranch`(hover 分支→同分支提交高亮,不淡出别的)。这三个状态在 `App` 顶层。

## 8. 已实现 ✅

- [x] Tauri 脚手架 + 原生窗口/红黄绿灯/系统字体/App 图标
- [x] 项目切换弹窗 + 打开真实仓库(原生文件夹选择器)
- [x] 读:真实分支 / 提交历史 / 提交图(拓扑) / 提交详情(文件+diff) / 工作区状态 / diff
- [x] 提交图:**按分支上色**(与侧栏一致)、合并来源上色、分支名标签、hover 联动高亮、点击聚焦只看一条、隐藏分支出图
- [x] 分支树:文件夹分组(`prefix/*`)、置顶、隐藏(单条/整组)、当前分支高亮、**双击切换分支**(确认弹窗 + 可储藏并切换)
- [x] **Cherry-pick**(遴选)真实可用
- [x] 远程:真实 `git remote` + 各远程的远程分支
- [x] Claude 暖色主题(亮/暗)、单时间线布局、滚动性能优化
- [x] **写操作(路线图 A)**:`git_fetch/pull/push`、`git_stage`→提交(`git_commit`,`-c user.name/email` 注入身份)、`git_create_branch`、`git_checkout_sync`。Push 走系统 git 认证
- [x] **创建 PR / MR(路线图 B)**:`reqwest` 调 GitLab/GitHub REST(`create_pull_request`),设置页填实例地址 + Token 并可**检测连接**(`gitlab_test`/`github_test`)
- [x] **多套提交者身份(路线图 C)**:设置页维护 `{name,email}` profile,默认身份 + 项目级覆盖,提交时注入,存 localStorage
- [x] **持久化 UI 状态(路线图 D 部分)**:置顶/隐藏/折叠/聚焦、身份、项目列表、主题、语言 → localStorage(键前缀 `gitkit.*`)
- [x] **打磨与发布(路线图 E)**:见下方"E 已落地"

**E. 打磨与发布 —— 已落地 ✅**(`cargo check` 通过、`npm run build` 通过)
- [x] **窗口背景**:使用不透明主题底色；已移除原生 vibrancy 开关与私有 API 依赖
- [x] **窗口状态记忆**:`tauri-plugin-window-state`(desktop setup 里注册,自动存/复原窗口位置与尺寸)
- [x] **自动更新**:`tauri-plugin-updater` + `tauri-plugin-process`。已生成 minisign 密钥对(公钥在 `tauri.conf.json`,私钥 `src-tauri/.tauri/gitkit-updater.key` 已 gitignore);前端「检查更新」→ 下载(带进度)→ 安装 → 重启。`bundle.createUpdaterArtifacts: true`
- [x] **代码签名 + 公证**:`tauri.conf.json > bundle.macOS` 配置位就绪 + 完整操作手册 **`RELEASE.md`**(证书、公证环境变量、latest.json、发布清单)。实际签名需你的 Apple 证书,只能在 Mac 上执行

## 9. 待办路线图 🚧

> A / B / C / E 已完成(见 §8)。剩下的是 D 的三项交互补齐。通用套路:**加 Rust 命令 → 注册 → git.ts 封装 → 相应 UI 调用 → 成功后 `setReloadTick`**(见 §10)。认证都靠系统 git。

### D. 补齐读/交互(唯一剩余项)
- **储藏列表**:目前 `App.tsx` 里 `stashes` 恒为 `[]`(侧栏「储藏」区永远空)。加 Rust `git_stash_list`(`git stash list --format=…`)→ 前端 `loadStashes` → 填进 `Sidebar`。再加 apply / pop / drop 命令。
- **搜索提交**:侧栏顶部「搜索提交…」(约 App.tsx L2705)是**静态占位**,无输入框。改成受控 input,按 message / 作者 / hash 过滤 `displayCommits`。
- **右键菜单**:提交 / 分支目前无 `onContextMenu`。加右键菜单(遴选、复制 hash、重置、删除/重命名分支等)。
- **Merge 按钮**:`ActionBar` 的「合并」仍是假 toast(A 的写操作里唯一没接的)。加 `git_merge(path, branch)`,选分支 → 调用 → 冲突把 stderr toast 出来。

> Token 存储目前是 localStorage 明文(设置页 hint 已注明"后续可迁移到系统钥匙串")。要更安全可换 `keyring` crate 或 `tauri-plugin-stronghold`。

### 发布相关
E 已落地(窗口记忆 / 自动更新 / 签名配置)。实际出包、签名、公证、发布更新的操作步骤见 **`RELEASE.md`**。

## 10. 加一个 Git 命令的标准套路(照抄即可)

以加 `git_push` 为例:

**1) `src-tauri/src/git.rs`** 新增命令 —— **必须是 `async fn` 且把 git 调用放进 `run_blocking`**。Tauri 把同步 `fn` 命令跑在**主线程**上,shell 调 git 会冻结整个 UI(大仓库首次加载卡 ~1s 就是这个原因)。`run_blocking` 把阻塞工作挪到 tokio 阻塞线程池:
```rust
#[tauri::command]
pub async fn git_push(path: String) -> Result<(), String> {
    run_blocking(move || {
        run_git(&path, &["push"])?;
        Ok(())
    })
    .await
}
```
> `run_blocking<T>` 是泛型的,返回 `Result<T, String>` —— 读命令(返回 Vec/结构体)和写命令(返回 `()`)都用它。**不要**再写裸的同步 `pub fn` 命令。

**2) `src-tauri/src/lib.rs`** 注册进 `invoke_handler`:
```rust
git::git_push,
```

**3) `src/git.ts`** 加前端封装(**参数名必须和 Rust 完全一致**):
```ts
export async function push(path: string): Promise<void> {
  await invoke("git_push", { path });
}
```

**4) `src/App.tsx`** 在 `ActionBar`/相应处调用,成功后刷新:
```ts
try { await push(activeProject.path); setReloadTick(n => n + 1); toast.success("已推送"); }
catch (e) { toast.error(`推送失败：${e}`); }
```

> `ActionBar` 目前是纯展示,需要把 `activeProject.path` 和这些 handler 传进去(现在它没有 props),或把按钮逻辑上提到 `App`。

## 11. 已知限制 / 坑

- **权限**:前端能调的能力受 `src-tauri/capabilities/default.json` 白名单限制。`data-tauri-drag-region` 需要 `core:window:allow-start-dragging`;对话框需 `dialog:allow-open`。加插件功能要在这里补权限。
- **invoke 参数名**:JS 传的 key 必须与 Rust 函数参数名一致(都用小写单词,别驼峰)。
- **命令必须 async + `run_blocking`**:Tauri 同步 `fn` 命令跑在主线程,shell 调 git 会冻结 UI。所有 git 命令都是 `async fn` 里包 `run_blocking`(见 §10)。
- **子进程 PATH**:macOS GUI 应用继承精简 PATH,不含 `/opt/homebrew/bin` 等。`run_git_auth` 用 `augmented_path()` 补上 Homebrew/MacPorts 路径,否则 `git-lfs`(checkout/merge 钩子和 smudge 过滤器会调它)找不到,操作报 "'git-lfs' was not found on your path" 而失败。新增任何 shell 调用都要注意同样问题。
- **LFS 钩子失败**:git-lfs 没装(或没在 PATH)时,`.git/hooks/post-checkout` 等钩子会 `exit 2`,让本已成功的 checkout/branch/merge 被判失败("Switched to a new branch …" 后跟 LFS 报错)。分支切换类命令(checkout / checkout -b / merge / cherry-pick / pull)统一走 `run_git_nohooks`(`-c core.hooksPath=/dev/null`)禁用客户端钩子;LFS 的 smudge/clean **过滤器**是 config 驱动、不受影响,大文件内容照常拉取。**push** 特殊:pre-push 钩子会**中止**推送(不像 post-* 钩子),所以先带钩子推(git-lfs 可用时正常上传 LFS 对象),失败且报 git-lfs-not-found 时(`is_lfs_missing`)自动禁用钩子重试一次,保证普通推送能成。
- **分支归属是启发式**:一个提交可能属于多条分支,`attributeBranches` 按"当前分支优先 + first-parent"只给一个 `branchLabel`。聚焦/隐藏基于它。
- **提交图泳道上限**:`graphW` 上限 148px(约 6 条并行泳道),再多会裁剪——所以鼓励用"聚焦单分支"。
- **提交行高度是公式算的**:依赖内容单行(ref/合并标签/信息/分支名都 `truncate`)。**若新增会换行的内容,要么保持单行,要么改回测量高度**,否则会重叠。
- **沙箱可 `cargo check` 但不出包**:前端 `npm run build`、后端 `cd src-tauri && cargo check` 都能验证编译;实际 `.app`/`.dmg`/签名/公证只能在 Mac 上 `npm run tauri build`。
- 失败的 `npm install` 可能残留坏 `node_modules`,重装前先 `rm -rf node_modules package-lock.json`。
- **窗口背景**:原生 vibrancy 已移除，窗口使用不透明背景；如重新引入透明窗口或私有 API，需重新评估发布渠道。
- **自动更新私钥不可丢**:`src-tauri/.tauri/gitkit-updater.key` 丢了就无法再签更新,所有客户端断更。务必离线备份(见 `RELEASE.md` §0.1)。
- **`createUpdaterArtifacts: true`**:release 构建必须导出 `TAURI_SIGNING_PRIVATE_KEY_PATH`,否则 `tauri build` 报错。本地纯冒烟可临时设 `false`。

## 12. 类型速查(`App.tsx` 里 `export`)

`Author` `CommitFile` `Commit(含 branchLabel)` `Branch(含 head/color)` `Stash` `Remote` `GraphRowInfo(含 colors)` `WorkingFile` `Project(含 real/path)`。前端 `git.ts` 从 `App.tsx` `import type` 复用它们。
