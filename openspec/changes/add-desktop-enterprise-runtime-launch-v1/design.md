## Context
OpenClaw Desktop 当前通过 `GatewayProcessManager` 启动 bundled `node.exe` 和 bundled `openclaw.mjs`，这是一个 packaged Electron 主进程托管的 gateway child process。enterprise shell 则在 OpenClaw Desktop 之外安装 decrypt loader、ESM hook bootstrap、bridge runtime 和 wrapper/payload 资产，并把完整 runtime contract 写入 Windows 当前用户环境变量与 install manifest。

现场验证表明，packaged Electron app 对 `NODE_OPTIONS` 中的 preload / `--import` 支持并不可靠，因此 enterprise shell 不能再把“Desktop 托管 gateway 会继承 `NODE_OPTIONS` 并自动激活 runtime”当成成立前提。

## Goals / Non-Goals
- Goals:
  - 让 Desktop-managed gateway 在 enterprise shell 已安装时显式注入 enterprise runtime。
  - 避免对 packaged Electron `NODE_OPTIONS` 语义的依赖。
  - 在 enterprise shell 未安装或损坏时保持普通 Desktop 用户体验不受影响。
  - 让支持人员可以从 Desktop 日志中明确判断 enterprise runtime 是否真正被加载。
- Non-Goals:
  - 不在 Desktop 内重新实现 enterprise shell 的安装器逻辑。
  - 不把 Desktop 改造成多租户 enterprise shell 管理平台。
  - 不在这次 change 中解决 enterprise hook seam 选择本身的全部兼容问题；本 change 聚焦“Desktop 如何显式加载 enterprise runtime”。

## Decisions
- Decision: Desktop 在启动 gateway child 前读取 enterprise install manifest，而不是依赖系统环境变量盲注入。
  - Why: manifest 提供了可验证的文件路径、support 目录和完整 `OPENCLAW_ENTERPRISE_*` 契约，比仅依赖 Explorer/Electron 进程环境更可控。

- Decision: Desktop 构造显式启动参数 `node.exe -r <decrypt-loader> --import <esm-bootstrap> openclaw.mjs gateway run ...`。
  - Why: 这绕开了 packaged Electron 对 `NODE_OPTIONS` 的限制，同时保留现有 bundled runtime 路径。

- Decision: enterprise runtime discovery 失败时 fail-open，回退到原生 OpenClaw Desktop 启动链。
  - Why: Desktop 是通用桌面分发，不应因为 enterprise shell 缺失或损坏而导致整体不可启动。

- Decision: Desktop 要记录结构化日志区分“未发现 enterprise shell”“manifest 无效”“enterprise runtime 注入成功”。
  - Why: 这能避免把“没有 hook 日志”误判为用户请求未命中，而能更快定位是在注入层还是在 seam 命中层。

## Alternatives Considered
- Keep relying on `NODE_OPTIONS`.
  - Rejected: packaged Electron 已证明这条路径不可靠，且支持人员难以判断 Desktop 是否真的继承到了变量。

- Ask users to always launch Desktop from a PowerShell session that exports enterprise env vars.
  - Rejected: 这不符合 Windows 桌面应用分发模型，也不适合作为支持流程默认要求。

- Modify OpenClaw core to load enterprise runtime natively.
  - Rejected: 这会把 desktop change 扩大成 core/runtime 架构变更，不符合当前边界。

## Risks / Trade-offs
- Risk: Desktop 会与 enterprise shell install manifest schema 形成耦合。
  - Mitigation: 只依赖稳定字段，并在 manifest 缺失或字段无效时 fail-open。

- Risk: enterprise runtime 文件路径失效时，Desktop 可能 silently fallback，导致支持误判。
  - Mitigation: 增加显式日志和验证输出，要求支持流程检查 Desktop enterprise launch status。

- Risk: 仅解决显式注入后，实际 hook target seam 仍可能因为 OpenClaw bundle 变化而不命中。
  - Mitigation: 在本 change 中把“注入成功”与“seam 命中成功”分层记录，后续 seam 匹配优化可以作为独立增量。

## Migration Plan
1. Desktop 增加 enterprise manifest discovery helper。
2. GatewayProcessManager 按 manifest 构建 enterprise launch spec。
3. 加入日志与验证。
4. 保留原生 fallback 路径，确保 enterprise 未安装用户无感知。

## Open Questions
- enterprise manifest 的稳定路径是否固定为 `%LOCALAPPDATA%\\OpenClawEnterpriseShell\\support\\install-manifest.json`，还是需要支持自定义根目录发现？
- Desktop 是否需要在 UI / diagnostics 中展示“enterprise runtime active”状态，还是先只写日志和验证脚本？
