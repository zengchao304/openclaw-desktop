# Project Context

## Purpose

`openclaw-desktop` 是一个面向 Windows 的 OpenClaw 桌面壳与安装器项目。它的目标不是重写 OpenClaw 本体，而是把上游 OpenClaw 运行时、Control UI、Node.js 运行环境和 Windows 原生桌面体验打包成一个可直接安装的产品：

- 用户下载一个 `.exe` 即可完成安装，无需手动安装 Node.js、npm 或在终端中配置 OpenClaw。
- 桌面壳负责首启向导、配置读写、网关进程托管、日志/诊断、插件与技能开关、备份恢复、自动更新、系统托盘等桌面侧能力。
- 项目需要持续跟踪上游 OpenClaw 的 breaking changes，并在桌面壳中做兼容、迁移与打包层修复。

一句话概括：这是一个“围绕上游 OpenClaw 运行时构建的 Windows 原生分发层和管理壳”，不是一个独立的 Agent 内核实现。

## Tech Stack

- 语言与运行时：
  - TypeScript，仓库整体启用 `strict`
  - Node.js `>= 22.16.0`
  - pnpm 9
- 桌面壳：
  - Electron 41
  - electron-vite 3
  - electron-builder 26
  - electron-updater 6
- 前端：
  - React 19
  - Vite（通过 electron-vite 集成）
  - Tailwind CSS 4
  - Radix UI primitives
  - Zustand
  - i18next + react-i18next
- 构建与脚本：
  - tsx
  - esbuild
  - Sharp / to-ico（资源生成）
- 其他关键库：
  - `ws` 用于网关/控制台相关通信
  - `json5` 用于配置兼容处理
  - `semver` 用于版本校验

## Project Conventions

### Code Style

- 默认使用 TypeScript，避免 `any`；如果必须放宽类型，优先局部收敛而不是把接口整体改成弱类型。
- React 侧使用函数组件与 Hooks，不使用 class component。
- 代码风格以“直接、清晰、少抽象”为主；已有代码中大量使用小模块拆分而非复杂框架封装。
- 命名约定：
  - 文件多使用 kebab-case，如 `process-manager.ts`、`gateway-response-headers.ts`
  - React 组件文件使用 PascalCase，如 `DashboardView.tsx`
  - IPC 常量统一放在 `src/shared/ipc-channels.ts`，以 `IPC_*` 命名
- 导入约定：
  - 渲染进程可通过 `@/` 指向 `src/renderer`
  - 主进程、预加载、共享代码通常使用相对路径并显式 `.js` 后缀，匹配 ESM 输出
- Lint 规则：
  - 使用 `eslint.config.mjs`
  - `@typescript-eslint/no-unused-vars` 开启，允许以下划线开头忽略未使用参数
  - React Hooks 规则开启，`exhaustive-deps` 为警告
- 注释策略：
  - 允许少量解释性注释，尤其在和 Electron、Windows、上游 OpenClaw 兼容性相关的边界逻辑中
  - 不要添加“翻译代码本身”的低价值注释

### Architecture Patterns

项目采用标准 Electron 三层结构，并明确区分职责：

- `src/main`
  - Electron 主进程
  - 负责窗口、托盘、自动更新、网关进程生命周期、配置读写、系统集成、诊断、插件/技能管理、安全补丁、备份等
  - 任何涉及文件系统、子进程、系统 API、网络拦截、自动更新的逻辑，优先放在这里
- `src/preload`
  - 通过 `contextBridge` 暴露受控 API 给渲染进程
  - `contextIsolation` 开启，`nodeIntegration` 关闭
  - 渲染进程不应直接访问 Node/Electron 能力，必须走 preload 暴露面
- `src/renderer`
  - React UI
  - 负责设置向导、嵌入式 Shell、设置页、技能页、更新页、飞书审批页等界面
  - 应尽量保持“展示与交互编排”职责，避免直接承载系统级逻辑
- `src/shared`
  - 主进程与渲染进程共享的类型、常量、IPC channel 定义

核心架构原则：

- 桌面壳是“编排层”，不是 OpenClaw 本体：
  - 与 Agent 运行、通道、模型、插件生态直接相关的核心能力优先依赖上游 OpenClaw
  - 本仓库负责托管、配置、打包、兼容与 Windows 体验
- 所有跨进程交互必须先定义共享 channel 和返回类型，再在 preload 暴露，再由 renderer 调用
- 任何新能力如果会影响系统边界，优先考虑是否应：
  - 加入 `src/main/*` 作为主进程服务
  - 在 `src/shared/*` 补类型
  - 在 `src/preload/index.ts` 暴露最小必要接口
- 嵌入式 Control UI 是一个特殊兼容层：
  - 本地 loopback 网关需要在主进程中补 request token、Origin、response headers
  - 这些 patch 只应针对桌面壳控制的本地网关流量，不能无边界放宽到远程模式
- 配置与迁移是第一类能力：
  - 上游 OpenClaw 版本变化频繁，很多桌面修复本质上是配置迁移、路径兼容、插件扫描兼容和打包修复

### Testing Strategy

这个仓库目前以“静态检查 + 构建验证 + 少量 smoke 脚本 + 发布链路校验”为主，没有成体系的单元测试框架。

基础检查：

- `pnpm run lint`
- `pnpm run type-check`
- `pnpm run build`

Smoke / 专项验证：

- `pnpm run smoke:csp`
  - 验证网关响应头与嵌入式 iframe/CSP 相关逻辑
- `pnpm run smoke:gateway`
  - 通过 Electron runner 验证 `process-manager` 等关键网关生命周期行为
- 常见打包/资源校验脚本：
  - `pnpm run check-openclaw-versions`
  - `pnpm run verify-bundle`
  - `pnpm run verify-packaged-win`
  - `pnpm run verify-native-modules`

CI 现状：

- GitHub Actions `ci.yml` 在 Ubuntu 上执行 `lint`、`type-check`、`build`
- CI 还会构建一次 OpenClaw Control UI，确保与 release 流水线一致，尽早发现上游 UI 破坏

发布前后建议：

- 如果改动涉及网关托管、Control UI 嵌入、安全头、打包资源、自动更新、插件扫描，至少跑一轮相关 smoke 或验证脚本
- 如果改动涉及安装器产物、资源布局、bundle 结构，优先验证 `prepare-bundle` / `verify-bundle` / `verify-packaged-win`

### Git Workflow

仓库没有在文档里强制规定复杂分支模型，但从现有历史可以看出以下约定：

- 日常开发基于 feature/fix 分支提 PR 到 `main`
- 提交信息倾向使用 Conventional Commits 风格，常见形式：
  - `fix(gateway): ...`
  - `fix(control-ui): ...`
  - `build: ...`
  - `chore(release): ...`
- 发布使用 Git tag 驱动，格式为：
  - `v<shell-version>+openclaw.<bundled-version>`
  - 示例：`v0.7.0+openclaw.2026.4.2`
- `package.json.version` 与 release tag 必须一致，仅 tag 多一个 `v` 前缀

对 AI assistant 的实际要求：

- 变更前先看工作树状态，不要回滚用户已有改动
- 涉及新能力、架构变化、breaking change、安全/性能大改时，按 OpenSpec 流程先写 proposal
- 小型 bug fix、文案、注释、非 breaking 配置调整可直接实现

## Domain Context

理解这个项目时，以下领域背景很重要：

- OpenClaw Desktop 依赖上游 OpenClaw 作为被捆绑运行时，桌面壳需要随着上游版本一起演进
- 项目主要服务“不想碰命令行的 Windows 用户”
- 桌面端需要同时处理三类状态：
  - OpenClaw 用户配置，例如 `%USERPROFILE%\\.openclaw\\openclaw.json`
  - 桌面壳自己的配置，例如窗口状态、语言、桌面偏好
  - 打包时生成的 bundle 与资源清单
- 项目对飞书配对审批有专门支持，这不是通用 IM 功能，而是 OpenClaw 通道能力在桌面端的可视化管理
- Control UI 不是本仓库从零实现的前端产品，而是上游 OpenClaw UI 的嵌入/构建/兼容产物
- 很多“看似桌面端 bug”的问题，根因可能来自：
  - 上游 OpenClaw 配置结构变更
  - 上游插件目录结构变更
  - 上游 Control UI 构建方式变更
  - Windows 安装路径、证书、资源、签名或代理环境差异

## Important Constraints

- 平台约束：
  - 目标用户平台是 Windows 10/11 x64
  - CI 可在 Linux 构建部分产物，但最终安装器在 Windows 打包
- 版本约束：
  - 根目录 `package.json` 中的 `openclawBundleVersion` 是桌面壳捆绑的 OpenClaw pin
  - 不要假设“始终跟随 npm latest”；版本升级必须显式处理兼容性
- Control UI 约束：
  - npm 包不一定自带可直接使用的 `dist/control-ui`
  - 当前 release 流水线在 Linux 构建 Control UI，再并入 Windows 安装包
  - 不要轻易改变这条流水线，除非已经验证 Windows 侧构建与资源布局都稳定
- 安全边界约束：
  - 渲染进程不能直接拿 Node 权限
  - 任何 iframe/CSP/Auth 相关放宽都必须限定在本地 loopback gateway 场景
  - 对外 URL 打开只允许显式白名单协议
- 配置兼容约束：
  - 读写 `openclaw.json` 时要考虑上游迁移、旧字段兼容、桌面端自动补丁
  - 不能为了“清理代码”而破坏已有用户配置升级路径
- 发布约束：
  - Release workflow 强依赖正确的 Git tag
  - tag、`package.json.version`、bundle pin、Control UI 构建产物必须一致，否则容易出现安装包混拼或黑屏

## External Dependencies

- 上游 OpenClaw：
  - npm 包 `openclaw`
  - GitHub release/tag 源码，用于补 Control UI 等构建资源
  - 上游文档与发布说明是兼容性判断的重要依据
- GitHub：
  - GitHub Actions 用于 CI 和 Release
  - GitHub Releases 用于桌面端自动更新分发
- Electron 生态：
  - `electron-builder` 用于 Windows 安装器打包
  - `electron-updater` 用于应用内更新
- 便携 Node.js 下载与打包资源：
  - 安装器会捆绑 Node.js 与 OpenClaw bundle
- 第三方模型与通道生态：
  - OpenAI、Anthropic、Gemini、DeepSeek、MiniMax、Kuae 等 provider
  - Feishu、Telegram、Discord、Slack、WhatsApp 等 channel
  - 这些集成多数由上游 OpenClaw 提供，桌面壳主要负责配置入口、测试入口和兼容包装
