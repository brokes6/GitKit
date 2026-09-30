import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectCatalog, collectNativeSources } from "../scripts/update-i18n-catalog.mjs";
import { languageProgress, setCurrentLanguage, tf, translateNativeMessage, tx } from "../src/i18n.ts";
import { invoke, isCancelled } from "../src/git.ts";

const catalog = JSON.parse(readFileSync(new URL("../src/i18n-catalog.json", import.meta.url), "utf8"));
const originalGlobals = { localStorage: globalThis.localStorage, document: globalThis.document, window: globalThis.window };
test.before(() => {
  globalThis.localStorage = { setItem() {}, getItem() { return "en"; } };
  globalThis.document = { documentElement: { lang: "en" } };
});
test.beforeEach(() => setCurrentLanguage("en"));
test.after(() => {
  setCurrentLanguage("zh-CN");
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("coverage includes current frontend and native sources and has no missing English entries", () => {
  assert.deepEqual(catalog, collectCatalog());
  assert.deepEqual(catalog.filter((source) => tx(source) === source), []);
  assert.equal(languageProgress("en"), 100);
  assert.equal(languageProgress("zh-CN"), 100);
  assert.ok(collectNativeSources().includes("接收对象"));
  assert.ok(collectNativeSources().includes("当前分支没有未推送的提交"));
  assert.ok(!catalog.includes("首页共享交互"), "test fixture text must not affect coverage");
});

test("native dynamic errors preserve Chinese paths, branch names and external output", () => {
  assert.equal(translateNativeMessage("目标已存在，请换个位置或先删除：/项目/设置 (旧)"),
    "The destination already exists. Choose another location or remove it first: /项目/设置 (旧)");
  assert.equal(translateNativeMessage("分支 设置 正被工作树占用：/项目/工作树\n需要先移除该工作树才能删除分支。"),
    "Branch 设置 is in use by worktree: /项目/工作树\nRemove that worktree before deleting the branch.");
  assert.equal(translateNativeMessage("读取 GitHub Token 信息失败（HTTP 503），请检查实例地址后重试"),
    "Could not read GitHub token details (HTTP 503). Check the instance URL and try again.");
  assert.equal(translateNativeMessage("无法读取 Git 输出：fatal: 设置\n第二行"),
    "Could not read Git output: fatal: 设置\n第二行");
  for (const source of ["fatal: 仓库不存在", "README mentions 接收对象", "https://host/设置.git", "__cancelled__"]) {
    assert.equal(translateNativeMessage(source), source);
  }
});

test("combined native errors translate both failures and prefer specific HTTP templates", () => {
  assert.equal(translateNativeMessage("当前分支没有未推送的提交；恢复分支失败：无效的提交哈希"),
    "This branch has no unpushed commits.\nCould not restore the branch: The commit hash is invalid.");
  assert.equal(translateNativeMessage("任务失败：无效的提交哈希"), "Task failed: The commit hash is invalid.");
  assert.equal(translateNativeMessage("请求失败：HTTP 403"), "Request failed: HTTP 403");
});

test("localized sentences and generated stash labels preserve dynamic values", () => {
  assert.equal(tf("将 {0} 遴选到 {1} 会在 {2} 个文件产生冲突：", "abc123", "设置", 2),
    "Cherry-picking abc123 onto 设置 will cause conflicts in 2 files:");
  assert.equal(tf("GitKit: 新建分支 {0} 前的改动", "工作区"), "GitKit: changes before creating branch 工作区");
  assert.equal(tf("GitKit: 切换到 {0} 前的改动", "设置"), "GitKit: changes before switching to 设置");
  assert.equal(tf("与 {0} 完全一致", "main"), "Identical to main");
});

test("Chinese mode retains native messages and original stash labels", () => {
  setCurrentLanguage("zh-CN");
  const source = "目标已存在，请换个位置或先删除：/项目";
  assert.equal(translateNativeMessage(source), source);
  assert.equal(tx("接收对象"), "接收对象");
  assert.equal(tf("GitKit: 切换到 {0} 前的改动", "main"), "GitKit: 切换到 main 前的改动");
});

test("invoke localizes native rejections without changing responses, arguments or cancellation", async () => {
  const args = { path: "/项目/设置" };
  const options = { headers: { "X-Test": "1" } };
  const response = { branch: "设置" };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, receivedArgs, receivedOptions) => {
    assert.equal(command, "git_test");
    assert.equal(receivedArgs, args);
    assert.equal(receivedOptions, options);
    return response;
  } } };
  assert.equal(await invoke("git_test", args, options), response);
  window.__TAURI_INTERNALS__.invoke = async () => { throw "当前分支没有未推送的提交"; };
  await assert.rejects(invoke("git_test"), (error) => error === "This branch has no unpushed commits.");
  window.__TAURI_INTERNALS__.invoke = async () => { throw "__cancelled__"; };
  await assert.rejects(invoke("git_test"), isCancelled);
  const structuredError = { message: "无效的提交哈希" };
  window.__TAURI_INTERNALS__.invoke = async () => { throw structuredError; };
  await assert.rejects(invoke("git_test"), (error) => error === structuredError);
});
