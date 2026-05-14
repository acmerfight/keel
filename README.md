# AI Agent — 编码 Agent 构建参考仓库

从零构建最优编码 Agent 的参考资料集合。包含业界主流编码 Agent 的源码（作为 git submodule）和技术调研报告。

## 参考项目

| 项目 | Stars | 语言 | 上游仓库 | 核心参考价值 |
|------|-------|------|---------|-------------|
| **Pi** | 49K | TypeScript | [earendil-works/pi](https://github.com/earendil-works/pi) | Agent Loop、编辑算法、Faux Provider 测试、Compaction |
| **OpenCode** | 159K | TypeScript | [anomalyco/opencode](https://github.com/anomalyco/opencode) | Wire Protocol 实现、VCR 测试、Provider/Protocol 分层 |
| **Codex CLI** | 82K | Rust | [openai/codex](https://github.com/openai/codex) | 沙箱执行、apply-patch 编辑策略 |
| **Claude Code** | 123K | Shell/TS | [anthropics/claude-code](https://github.com/anthropics/claude-code) | 工具命名、System Prompt 设计 |
| **Aider** | 44K | Python | [Aider-AI/aider](https://github.com/Aider-AI/aider) | Repo-map（tree-sitter + PageRank）、多层编辑回退 |

## 文件说明

- `final-report.md` — 完整技术报告《从零构建最优编码 Agent》（2026-05-12）

## 各项目关键文件索引

### Pi — 整体参考价值最高

- `pi/packages/agent/src/agent-loop.ts` (718 行) — 核心 Agent 循环，事件流 + 工具并行/顺序执行
- `pi/packages/agent/src/types.ts` (410 行) — AgentContext / AgentEvent / AgentTool 类型定义
- `pi/packages/coding-agent/src/core/tools/edit-diff.ts` (446 行) — 编辑算法：精确匹配 + Unicode 标准化回退
- `pi/packages/ai/src/providers/faux.ts` (499 行) — 确定性测试 Provider，E2E 测试基石
- `pi/packages/ai/src/providers/anthropic.ts` (1,207 行) — Anthropic SDK 适配层
- `pi/packages/coding-agent/src/core/compaction/compaction.ts` (845 行) — 结构化 Compaction

### OpenCode — Wire Protocol 差异参考

- `opencode/packages/llm/src/protocols/anthropic-messages.ts` (691 行)
- `opencode/packages/llm/src/protocols/openai-chat.ts` (420 行)
- `opencode/packages/llm/src/protocols/openai-responses.ts` (593 行)
- `opencode/packages/llm/src/protocols/gemini.ts` (422 行)
- `opencode/packages/llm/src/protocols/bedrock-converse.ts` (634 行)
- `opencode/packages/http-recorder/` — VCR 录制回放测试

### Aider — 独一无二的 Repo-map

- `aider/aider/repomap.py` (867 行) — tree-sitter 解析 + PageRank 排序 + token budget 拟合
- `aider/aider/coders/search_replace.py` (757 行) — 多层编辑回退链

### Codex CLI — 沙箱参考

- `codex/codex-rs/linux-sandbox/` — Linux 沙箱
- `codex/codex-rs/apply-patch/` — Patch 编辑策略

## 用法

```bash
# 克隆（含所有 submodule）
git clone --recurse-submodules git@github.com:acmerfight/ai-agent.git

# 更新某个子项目到上游最新
git submodule update --remote pi
git add pi && git commit -m "update pi to latest"

# 更新全部子项目
git submodule update --remote
```
