# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PocketRelay - A CLI tool to remotely control code agents (Claude Code, Codex, etc.) from Feishu mobile app.

## 项目概述

PocketRelay - 手机飞书远程控制代码 Agent（Claude Code、Codex 等）的 CLI 工具。

## 技术栈

- **包管理**: pnpm workspace (monorepo)
- **构建工具**: tsup (打包成 CJS 格式)
- **语言**: TypeScript
- **CLI 框架**: commander

## 项目结构（必读）

```
packages/
├── types/       # 类型定义
├── executor/    # 执行器层（通用接口 + 多种 Agent 实现：ClaudeCodeExecutor、[未来] CodexExecutor）
├── channel/     # 通信通道（LarkChannel）
└── core/        # CLI 入口 + Daemon
    ├── src/
    │   ├── index.ts        # ✅ 唯一入口（导出 + 自动执行）
    │   ├── logger.ts
    │   ├── config.ts
    │   ├── cli/            # CLI 命令（pcr config/start）
    │   └── daemon/         # Daemon + 飞书斜线命令（/bind 等）
```

## 约束与规范（必读）

### 1. 入口文件规范
- **唯一入口**: `packages/core/src/index.ts`
- **打包入口**: 根目录 `tsup.config.ts` 的 entry 指向 `packages/core/src/index.ts`
- **导出内容**: `runCli()` + 公共类（Daemon, SessionManager, TaskQueue）
- **自动执行**: index.ts 底部自动调用 `runCli()`

### 2. 目录结构规范
- **cli/** - 只放 `pcr xxx` CLI 命令
- **daemon/** - 只放 Daemon 相关和飞书斜线命令（`/xxx`）
- **daemon/commands/** - 飞书斜线命令必须实现 `IFeishuCommand` 接口
- **禁止**: 命令通过接口访问 Daemon，**不能直接访问私有方法**

### 3. 斜线命令规范
- 必须实现 `IDaemonCommand` 接口
- 通过 `IDaemonCommandContext` 接口访问 Daemon 能力
- **禁止**: 直接访问 `daemon['privateMethod']`

### 4. 构建规范
- 输出格式: CJS (`.cjs`)
- 输出文件: `dist/index.cjs`（根目录）
- 构建配置: 根目录 `tsup.config.ts`（统一管理，子包无独立构建配置）
- Shebang: 通过 tsup 的 `banner.js` 添加，**不在源码里写**
- workspace 包: `noExternal: [/@pocket-relay\//]` 强制 bundle

### 5. tsconfig 规范
- `module: ESNext`
- `moduleResolution: Bundler`
- **禁止**: 相对导入带 `.js` 扩展名

### 6. 编码偏好
- 偏好函数式编程，但必须根据实际场景选择面向对象还是函数式；需要技术决策时询问用户
- 函数式编程与面向对象编程配合使用

### 7. 注释规范
- 所有 class、interface、public 方法、导出函数必须写 JSDoc 注释
- 注释说明"为什么"而非"是什么"，逻辑不自明时才写行内注释
- 复杂逻辑、非显而易见的设计决策必须注释说明原因

### 8. AGENTS.md 同步规范
- 每次完成调研、编码、功能分析、踩坑修复等关键工作后，**必须同步更新对应子包的 `AGENTS.md`**
- 更新位置：各子包 `AGENTS.md` 的"关键工作点（接力必读）"章节
- 更新内容：已踩的坑、关键设计决策、非显而易见的约束、待解决的已知问题
- **提醒开发者**：如果用户忘记更新，AI Agent 应主动提示

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm build` | 构建整个项目（根目录 tsup） |
| `pnpm dev` | 监听模式构建（watch 所有源码变化） |
| `pnpm start` | 直接运行已构建产物 |
| `npm link` | 链接到全局 |
| `pcr --help` | 查看 CLI 帮助 |
| `pcr start` | 启动 Daemon（Spawn 模式，默认） |
| `pcr start --executor-mode acp` | 启动 Daemon（ACP 长连接模式） |
| `pcr config list` | 查看所有配置项 |

## 构建配置说明

- tsup 配置：根目录 `tsup.config.ts`
- 输出格式：CJS (`.cjs`)
- 输出文件：`dist/index.cjs`（根目录）
- 关键配置：`noExternal: [/@pocket-relay\//]` - 强制 bundle 所有 workspace 包

## Multi-Agent Architecture (多 Agent 架构)

PocketRelay is designed with an extensible executor layer to support multiple code agents, not just Claude Code.

### Key Concepts

- **`IExecutor` Interface**: The common interface that all agents must implement
  - `execute()`: Execute a task with the agent
  - `cancel()`: Cancel an ongoing task

- **`SpawnExecutor`**: Base class for CLI-based agents (handles spawning subprocesses, stdout/stderr streaming)

- **`ClaudeCodeExecutor`**: Reference implementation for Claude Code

- **`OutputBuffer`**: Generic output buffering for sending chunks back to Feishu

### Adding a New Agent

To add support for a new agent (e.g., Codex):

1. Create a new class in `packages/executor/src/[agent-name]/` that implements `IExecutor`
2. If it's a CLI-based agent, extend `SpawnExecutor` for convenience
3. Export it from `packages/executor/src/index.ts`
4. Update `Daemon` to allow selecting different agents (future enhancement)

### Execution Modes

The executor layer supports two execution modes, selected via `pcr start --executor-mode`:
- **Spawn mode** (default): One-shot process per task (`ClaudeCodeExecutor`). Simpler, more reliable.
- **ACP mode**: Long-running agent with interactive callbacks (`ClaudeCodeAcpExecutor`). Supports permission requests and progress updates but has known output ordering/duplication issues — see `packages/executor/docs/acp-known-issues.md`.

## 三种 ID 类型（必读）

理解这三种 ID 是读懂 Daemon/SessionManager 代码的前提：

| ID | 来源 | 用途 |
|----|------|------|
| `chatId` | 飞书消息 | 标识飞书会话，用于回复消息 |
| `sessionId` | nanoid 生成 | PocketRelay 内部 session 标识 |
| `claudeSessionId` | Claude Code 返回 | 用于 `--resume` 恢复上下文 |

`SessionManager` 维护 `chatId → { sessionId, claudeSessionId }` 的映射。

## 关键依赖说明

- **`@larksuiteoapi/node-sdk`**: 已通过 pnpm patch 修复 `WSClient.start()` 不等待连接就绪的 bug（见 `patches/` 目录）。升级该包版本前必须重新验证 patch 是否仍适用。
- **`@agentclientprotocol/claude-agent-acp`**: ACP 模式专用，仅在 `ClaudeCodeAcpExecutor` 中使用。
- **`@anthropic-ai/claude-agent-sdk`**: 仅用于 `SessionListCommand` 中调用 `listSessions()`。

## 深度文档

`docs/` 目录包含关键设计决策的详细说明：
- `04-session-chat-id-explained.md` — 三种 ID 的完整解释
- `05-claude-code-acp-executor.md` — ACP 模式实现细节
- `08-integrated-session-management.md` — Session 管理架构
- `10-feishu-card-sdk-guide.md` — 飞书卡片交互实现

**必读**: 每个子包下的 `AGENTS.md`
