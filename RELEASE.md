# GitKit — 发布手册 / Release Guide

打包、**代码签名 + 公证**、**自动更新**发布的完整操作步骤。仅在 macOS 上执行。

---

## 0. 一次性准备

### 0.1 更新签名密钥(已生成,勿丢)

自动更新要求每个更新包都用 minisign 私钥签名,客户端用内置公钥校验。密钥已生成:

- 私钥:`src-tauri/.tauri/gitkit-updater.key`(**已 gitignore,绝不提交**)
- 公钥:`src-tauri/.tauri/gitkit-updater.key.pub`(已写进 `tauri.conf.json > plugins.updater.pubkey`)

> ⚠️ **务必把私钥离线备份**(密码管理器 / 加密 U 盘)。丢了私钥就无法再签任何更新,所有旧客户端将永远收不到更新,只能让用户手动重装。

如需重新生成(会让已发布客户端全部失效,慎用):
```bash
npx tauri signer generate -w src-tauri/.tauri/gitkit-updater.key
# 把新 .pub 内容粘贴回 tauri.conf.json 的 plugins.updater.pubkey
```

### 0.2 Apple 证书(分发必需)

1. 加入 Apple Developer Program(个人 $99/年)。
2. 在钥匙串里安装 **Developer ID Application** 证书(用于 App Store 外分发)。
3. 创建 **App 专用密码**:appleid.apple.com → 登录与安全 → App 专用密码。

### 0.3 更新分发地址

把 `tauri.conf.json > plugins.updater.endpoints` 里的 `OWNER` 换成真实 GitHub 用户/组织名(或换成自建的静态托管地址):
```
https://github.com/你的账号/gitkit/releases/latest/download/latest.json
```

---

## 1. 打包 + 签名 + 公证

三件事由一条 `tauri build` 完成,靠环境变量驱动:

```bash
# ── 更新包签名(自动更新必需)──
export TAURI_SIGNING_PRIVATE_KEY_PATH="$PWD/src-tauri/.tauri/gitkit-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # 生成时没设密码就留空

# ── 代码签名 ──
export APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"

# ── 公证(三选一组)──
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"    # App 专用密码
export APPLE_TEAM_ID="TEAMID"

rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

产物在 `src-tauri/target/universal-apple-darwin/release/bundle/`:
- `macos/GitKit.app`、`dmg/GitKit_x.y.z_universal.dmg`
- `macos/GitKit.app.tar.gz` + `GitKit.app.tar.gz.sig`(**更新包 + 签名**,`createUpdaterArtifacts: true` 才生成)

Tauri 会自动:签名 → 开启 Hardened Runtime → 提交公证 → staple(装订公证票据)。

> 只想本地冒烟测试、不签名:临时把 `tauri.conf.json > bundle.createUpdaterArtifacts` 设为 `false`,并且不导出 `APPLE_*`(签名会跳过,但产物无法分发/自动更新)。

---

## 2. 发布一个新版本

1. 改版本号:`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处 `version` 保持一致。
2. 按上面第 1 步打包(带全部环境变量)。
3. 建一份 `latest.json`(更新清单),`signature` 字段填 `.sig` 文件内容:
   ```json
   {
     "version": "0.2.0",
     "notes": "本次更新说明",
     "pub_date": "2026-07-08T00:00:00Z",
     "platforms": {
       "darwin-universal": {
         "signature": "把 GitKit.app.tar.gz.sig 的内容粘到这里",
         "url": "https://github.com/你的账号/gitkit/releases/download/v0.2.0/GitKit.app.tar.gz"
       }
     }
   }
   ```
4. 在 GitHub 建 Release `v0.2.0`,上传 `GitKit.app.tar.gz`、`.dmg`、`latest.json`。
5. 客户端「设置 → 外观与更新 → 检查更新」即可拉到新版本(endpoint 用的是 `latest/download/latest.json`,始终指向最新 Release)。

---

## 3. 发布检查清单

- [ ] 三处 `version` 已同步递增
- [ ] `plugins.updater.endpoints` 里的 `OWNER` 已替换为真实账号
- [ ] 打包时导出了 `TAURI_SIGNING_PRIVATE_KEY_PATH`(否则无 `.sig`,自动更新失效)
- [ ] 导出了 `APPLE_SIGNING_IDENTITY` + `APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID`
- [ ] 公证成功(日志出现 `Notarization finished` / staple 成功)
- [ ] `latest.json` 的 `signature` 用的是本次 `.sig`、`url` 指向本次 Release 的 tar.gz
- [ ] 私钥已离线备份

---

## 4. 常见坑

- **`"App is damaged"` / 无法打开**:没签名或没公证。分发必须两步都做。
- **自动更新报签名校验失败**:`latest.json` 的 `signature` 和实际 `.app.tar.gz` 不是同一次构建产物;或客户端内置 `pubkey` 与签名私钥不配对。
- **`createUpdaterArtifacts: true` 但没导出私钥**:`tauri build` 直接报错。要么导出 `TAURI_SIGNING_PRIVATE_KEY_PATH`,要么临时设为 `false`。
- **窗口背景**:当前配置已移除 vibrancy 与 `macOSPrivateApi`。若未来重新启用私有 API，需重新评估 App Store 发布资格。
