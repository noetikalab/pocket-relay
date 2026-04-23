---
name: project-pr-review
description: Review a GitHub Pull Request for the PocketRelay project. 触发时机：用户说"review PR"、"看一下PR"、"review #N"、"查看PR"、"pr-review"。流程：读取 PR diff → 分析代码质量 → 提交 review 评论到 GitHub。
---

# project-pr-review

分析 GitHub Pull Request，给出代码 review 意见，并提交到 GitHub。

## 步骤

1. **确定 PR 号**：用户未指定时，列出开放 PR 让用户选择
   ```bash
   gh pr list --state open
   ```

2. **读取 PR 信息**：
   ```bash
   gh pr view <number>
   gh pr diff <number>
   ```
   如果 PR 来自 fork，本地没有对应文件，只能从 diff 分析。

3. **分析代码**，重点关注：
   - 新增依赖是否真正被使用（对照 import 语句）
   - 内存泄漏风险（无界集合、未清理的定时器）
   - 与现有同类实现的一致性（如有类似文件，参考其做法）
   - 无关改动混入（与 PR 主题不相关的 fix/refactor/文档删除）
   - 文档改动是否误删了重要内容

4. **给出 review 意见**，格式：
   - 按严重度分级：中 / 低
   - 每个问题：现象 → 影响 → 建议（可附代码参考或文件行号）

5. **询问用户**是否将评论提交到 GitHub

6. **提交评论**（用户确认后）：
   ```bash
   gh pr review <number> --comment --body "..."
   ```

## 规则

- 只提交 `--comment`，不自动 approve 或 request-changes
- 提交前必须向用户展示评论内容并等待确认
- PR 来自 fork 时，说明只能基于 diff 分析，无法读取本地文件
