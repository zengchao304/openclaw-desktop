# OpenClaw Desktop 黑屏问题排查与修复总结

## 1. 问题现象

- 其他电脑下载 GitHub 最新 desktop exe，安装并完成向导后进入主界面黑屏（窗口有标题）。
- 浏览器直接访问 `http://127.0.0.1:18789` 也黑屏。
- 浏览器控制台出现报错：`Uncaught SyntaxError: Invalid or unexpected token`（示例：`index-B-iMcseq.js:813`）。

## 2. 关键结论

本次问题核心不是单一 iframe 样式问题，而是 **安装包资源混拼/版本错配** 导致的 Control UI 资源异常。

已确认的强证据：

- 仓库源码版本为 `0.2.16`（`package.json`）。
- 打包产物 `dist/win-unpacked/resources/bundle-manifest.json` 中 `shellVersion` 为 `0.2.7`。
- 同一产物中 `app.asar` 里的 `package.json` 版本为 `0.2.8`。

同一安装包内出现 `0.2.16 / 0.2.8 / 0.2.7` 三套版本信息，不一致即是混拼信号。  
此情况下 `control-ui/index.html` 与 `assets/index-*.js` 可能来自不同构建，最终触发 JS 语法错误并黑屏。

## 3. 受影响链路

- GitHub Release 打包流程中，`download-openclaw` 默认取 npm `latest`，存在时间漂移风险。
- 若发布作业复用旧产物或缺少“打包后版本一致性校验”，容易把旧 `app.asar` / 旧 `bundle-manifest` 混入新 tag 产物。
- 用户侧若配置残留 `gateway.controlUi.root` 指向旧路径，也会放大该问题（加载到错误 UI 资源）。

## 4. 已落地代码修复（仓库内）

### 4.1 运行时配置迁移与兜底

- 本地模式下，若 `gateway.controlUi.root` 指向非 bundled Control UI，自动移除，避免加载旧路径资源。
- 诊断项新增检测：`gateway.controlUi.root` 指向 bundled 之外路径时给出 warning。
- 网关 token 注入从 `webSocket` 扩展到 `mainFrame/subFrame/webSocket`，降低新旧 UI token 读取差异风险。

### 4.2 启动前资源一致性校验（已增强）

- 启动前检查 `dist/control-ui/index.html` 是否引用且可找到对应 `assets/index-*.js`。
- 启动前检查 `resources/bundle-manifest.json` 与 `app.getVersion()` 是否一致：
  - 不一致直接报错并阻止进入黑屏界面。
  - 明确提示“安装包混拼/过期，需重装验证过的发布产物”。

## 5. 发布流程修复（已实施）

1. **固定 OpenClaw bundle 版本**：根目录 `package.json` 增加 `openclawBundleVersion`；`download-openclaw` 与 CI `ci-build-openclaw-control-ui` 优先读取该字段（可被 `OPENCLAW_DESKTOP_BUNDLE_VERSION` 或 CLI 参数覆盖），避免仅依赖 npm `latest` 的时间漂移。
2. **打包后强校验**：`pnpm run package:win` 末尾自动执行 `verify-packaged-win`（`scripts/verify-packaged-win.ts`），失败即中断：
   - `app.asar` 内 `package.json.version` === 根 `package.json.version`
   - `resources/bundle-manifest.json.shellVersion` === 根 `package.json.version`
   - `bundle-manifest.bundledOpenClawVersion` === `resources/openclaw/package.json.version`（及 `.openclaw-version` 若存在）
   - `control-ui/index.html` 中 `script` / `modulepreload` 引用的本地资源在磁盘上存在
3. **发布工件**：Release workflow 仍为单次检出 → 构建 → 上传 artifact；请勿在本地把历史 `dist/` 混入当前 tag 再发布。
4. **校验摘要**：`publish_release`  job 已生成 `OpenClaw-Setup-*.exe.sha256`；打包一致性由上述脚本在构建机强制保证。

**升级 OpenClaw 时**：同步 bump 根 `package.json` 的 `openclawBundleVersion`，并跑通完整 `package:win`（含 `verify-packaged-win`）。

## 6. 用户侧应急处理建议

1. 删除 `openclaw.json` 中 `gateway.controlUi.root`（若存在）。
2. 确认：
   - `gateway.controlUi.allowInsecureAuth=true`
   - `gateway.auth.mode` 合法且 token 非空
3. 重启 Desktop/Gateway。
4. 若仍黑屏，重新下载安装包并核对 SHA256。

## 7. 结语

本问题本质是“发布工件一致性”问题，不是单一前端组件 bug。  
后续应以“打包后强校验 + 版本固定 + 产物不可混用”作为防线，避免同类黑屏回归。

