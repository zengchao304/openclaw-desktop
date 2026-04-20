# Change: Add Explicit Enterprise Runtime Launch For Desktop-Managed Gateway

## Why
OpenClaw Desktop 当前通过 Electron 主进程拉起 bundled `node.exe openclaw.mjs gateway run ...`。这一链路默认继承 `process.env`，但 packaged Electron app 不可靠支持 `NODE_OPTIONS` 中的 preload / `--import` 注入，因此外部 enterprise shell 即使已正确安装，也无法稳定把 decrypt loader、ESM hook 和 bridge runtime 接到 Desktop 托管 gateway。

现场现象已经验证了这一点：enterprise runtime 的 `openclaw-esm-run-hook.jsonl` 只会在 PowerShell 直接运行 bundled `node.exe` 时生成，而不会在重新启动 OpenClaw Desktop 后生成。这意味着 Desktop 当前并没有真正加载 enterprise runtime。

## What Changes
- 为 Desktop-managed gateway 增加显式 enterprise runtime launch 路径，不再依赖 `NODE_OPTIONS` 把 `-r decrypt-loader.js` 和 `--import openclaw-esm-run-hook.bootstrap.mjs` 注入 packaged Desktop app。
- 在 Desktop 主进程启动 gateway 前，尝试发现 enterprise shell 的 install manifest，并从 manifest 中读取 runtime 路径和 `OPENCLAW_ENTERPRISE_*` 环境契约。
- 当 enterprise manifest 完整且有效时，Desktop 应显式构造 `node.exe -r <decrypt-loader> --import <esm-bootstrap> openclaw.mjs gateway run ...`。
- 当 enterprise shell 未安装、manifest 缺失或 runtime 路径失效时，Desktop 必须 fail-open 回退到原生 `node.exe openclaw.mjs gateway run ...`，不得阻塞普通用户启动。
- 增加 Desktop 侧日志与验证，明确区分：
  - 未发现 enterprise shell
  - 发现但 manifest 无效
  - enterprise runtime 显式注入成功
- 更新打包验证与支持文档，覆盖 Desktop 托管 gateway + enterprise shell 联合部署场景。

## Impact
- Affected specs: `desktop-enterprise-runtime-launch`
- Affected code:
  - `src/main/gateway/process-manager.ts`
  - `src/main/utils/*` or new enterprise manifest helper
  - `scripts/verify-bundle.ts`
  - Desktop support/build docs and smoke coverage
