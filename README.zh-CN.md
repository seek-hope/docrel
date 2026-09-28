# DocRelay — 代码与文档的关系型同步系统

[**English**](README.md)

[![CI](https://github.com/seek-hope/docrel/actions/workflows/ci.yml/badge.svg)](https://github.com/seek-hope/docrel/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/doc-relay)](https://www.npmjs.com/package/doc-relay)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

**像管理数据库一样管理文档。** DocRelay 将关系型数据库的概念——外键、级联更新（CASCADE）、CHECK 约束——应用于代码与文档的同步。无需手动标注。

当你重构代码时，DocRelay 会告诉你的 AI Agent（或你自己）哪些文档段落需要更新，甚至可以自动完成更新。

## 核心理念

> 数据库靠外键保证引用完整性——代码和文档为什么不能？

| 数据库概念 | DocRelay 实现 |
|-----------|------------|
| 主键 (PK) | 稳定符号 ID — `SHA256(语言:全限定名:类型)`，重命名/移动文件后 ID 不变 |
| 外键 (FK) | 符号 ↔ 文档段落映射表（JOIN 表） |
| ON UPDATE CASCADE | 代码变更 → 自动更新关联文档（按文档类型可配置策略） |
| CHECK 约束 | Git hooks 在提交/推送前校验文档同步状态 |
| WAL 日志 | 完整的变更日志追踪每次符号修改 |

DocRelay 使用 [Codegraph](https://github.com/colbymchenry/codegraph) 追踪符号的重命名和文件移动——文档关联在重构后依然存活。

## 快速开始

### 安装

```bash
npm install -g doc-relay
```

### 在项目中使用

```bash
cd your-project

# 一键初始化（配置 + 数据库 + git hooks + 扫描）
doc-relay init

# 查看文档健康度
doc-relay status
```

### CLI 命令一览

| 命令 | 描述 |
|------|------|
| `doc-relay init` | 一键初始化：配置、数据库、git hooks、代码扫描 |
| `doc-relay status` | 健康仪表盘 — 符号数、关联率、文档同步率 |
| `doc-relay check` | 列出过期文档。`--strict` 时退出码为 1（CI 友好） |
| `doc-relay impact <文件...>` | 展示哪些文档受代码变更影响 |
| `doc-relay sync --symbol <id>` | CASCADE 更新某个符号关联的文档 |
| `doc-relay confirm` / `doc-relay reject` | 批准或拒绝待处理的同步建议（支持 `--all`、`--pattern`） |
| `doc-relay link create --symbol <id> --doc <id>` | 手动创建映射 |
| `doc-relay diff <符号id>` | 查看符号的变更历史 |
| `doc-relay history` | confirm/reject 决策的审计记录（`--limit`、`--symbol`、`--format`） |
| `doc-relay scan` | 扫描代码库发现符号（`--incremental`、`--dry-run`） |
| `doc-relay review` | 过期/待处理文档的审查队列 |
| `doc-relay watch` | 监听代码库并在变更时重新扫描（`--daemon` 后台运行） |
| `doc-relay health` | 8 项健康检查（配置、数据库、hooks、codegraph、新鲜度） |
| `doc-relay export-mappings` | 导出 `.docrelay/mappings.json` 供 CodeGraph 集成 |
| `doc-relay install-hooks` | 安装 pre-commit / post-commit / pre-push hooks |
| `doc-relay integrate` | 自动检测 AI Agent 并写入 DocRelay 配置 |
| `doc-relay gc` | 回收代码库中已不存在的符号 |
| `doc-relay backup` / `doc-relay restore` | 备份 / 恢复 DocRelay 数据库 |
| `doc-relay config show/validate/reset` | 查看、校验或重置配置 |
| `doc-relay mcp` | 在 stdio 上启动 MCP server（供 Agent MCP 配置使用） |
| `doc-relay update` | 通过 npm 更新 DocRelay 到最新版本 |

### MCP Server 用法

在 Agent 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "docrelay": {
      "command": "npx",
      "args": ["-y", "doc-relay", "mcp"],
      "env": {
        "DOCRELAY_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

运行 `doc-relay integrate` 可自动写入该配置（自动检测 Claude Code、Codex、OpenCode、Oh My Pi 等）。

DocRelay 提供 17 个 MCP 工具（与 CLI 对应）：`docrelay_status`、`docrelay_check`、`docrelay_impact`、`docrelay_sync`、`docrelay_sync_all`、`docrelay_link`、`docrelay_confirm`、`docrelay_reject`、`docrelay_diff`、`docrelay_history`、`docrelay_scan`、`docrelay_review`、`docrelay_integrate`、`docrelay_watch`、`docrelay_watch_status`、`docrelay_refresh`、`docrelay_health`。

### 配置（`.docrelay/config.yaml`）

```yaml
project: my-project
doc_dirs:
  - docs
  - README.md
code_dirs:
  - src
strategies:
  inline: auto_update       # 代码内注释 — 直接改写源文件
  standalone: auto_update   # Markdown 文档 — 生成 diff 供审查
  generated: auto_update    # TypeDoc/OpenAPI — 重新运行生成器
  architecture: mark_stale  # 架构文档 — 仅标记过期
```

## 端到端示例

```
用户："把 login() 重命名为 authenticate()"

Agent 调用: docrelay_impact(paths=["src/auth.ts"])
→ 返回:
  - 1 个符号受影响: login (函数)
  - 3 份关联文档:
    • src/auth.ts (内联注释) — 将自动更新
    • docs/api.md § 认证 (独立文档) — 将重写段落
    • docs/architecture/security.md (架构文档) — 标记过期

Agent 重构代码 → login() → authenticate()

Agent 调用: docrelay_sync("auth:login")
  ├─ 内联注释 ✅ 已在 src/auth.ts 中更新
  ├─ docs/api.md 段落 ✅ 已用新签名重写
  └─ docs/architecture/security.md ⚠️ 已标记为 stale

pre-commit hook: docrelay_check --strict
→ security.md 已过期 → 用户决定审查后更新

提交信息自动附加:
  DocRelay: 1 个符号变更，2 份文档已同步，1 份文档待审查
```

### Git Hook 行为

| Hook | 行为 |
|------|------|
| **pre-commit** | `doc-relay check --strict` — 存在过期文档则阻止提交 |
| **post-commit** | `doc-relay impact` — 标记受影响文档为过期 |
| **pre-push** | `doc-relay check --strict` — 有过期文档则阻止推送 |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: Agent 适配层                    │
│  Claude Code (MCP)  │  OpenCode (MCP)  │  任意 Agent (CLI) │
├─────────────────────────────────────────────────────────────┤
│                    Layer 2: DocRelay 核心                     │
│  影响分析器  │  CASCADE 引擎  │  Git Hooks                 │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: 数据存储                        │
│  .git/docrelay.db (SQLite)  │  .docrelay/ 配置 & 映射          │
├─────────────────────────────────────────────────────────────┤
│                    Layer 0: 符号后端                         │
│              Codegraph (符号身份追踪)                        │
└─────────────────────────────────────────────────────────────┘
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript (ES2023, NodeNext, ESM) |
| MCP Server | `@modelcontextprotocol/sdk` |
| 数据库 | SQLite via `better-sqlite3` |
| 符号后端 | Codegraph MCP Server (`colbymchenry/codegraph`) |
| CLI | `commander` |
| Git | `simple-git` + 原生 hooks |
| 测试 | `vitest`（239 测试，23 套件） |

## Codegraph 集成

DocRelay 使用 [Codegraph](https://github.com/colbymchenry/codegraph) 作为符号智能后端：

- **自动发现**：通过 codegraph 索引扫描并填充 `symbols` 表
- **变更追踪**：通过 codegraph 的符号身份检测签名变化
- **影响分析**：使用 `codegraph_analyze_impact` 查找受影响的文档
- **`doc_refs` 字段**：已向 CodeGraph 提交[轻量 PR](https://github.com/colbymchenry/codegraph/pull/6)，在 impact 响应中新增 `doc_refs` 字段

```bash
# 生成 CodeGraph 读取的文件：
doc-relay export-mappings
# → 写入 .docrelay/mappings.json

# 之后 codegraph_analyze_impact 的响应会自动包含：
# "doc_refs": [{"doc_file": "docs/api.md", "symbol_name": "login", ...}]
```

## 文档

- [快速上手](docs/getting-started.md) — 安装、初始化、日常工作流
- [CLI 参考](docs/cli-reference.md) — 全部 23 个命令及参数
- [配置说明](docs/configuration.md) — `.docrelay/config.yaml` 配置项
- [MCP 集成](docs/mcp-integration.md) — Agent 接入与全部 16 个工具
- [架构](docs/architecture.md) — 关系型同步模型

## 常见问题

**需要手动标注代码吗？** 不需要。DocRelay 是零标注的。Codegraph 自动发现符号，DocRelay 解析文档中的代码引用，映射自动建立。

**支持哪些语言？** DocRelay 本身是语言无关的。Codegraph 后端支持 37+ 种语言（TypeScript、Python、Rust、Go、Java、C/C++ 等）。

**不用 AI Agent 能用吗？** 可以用。CLI 提供完整的文档健康可见性。Git hooks 独立于 Agent 强制执行一致性。

**可以自定义同步策略吗？** 可以。每种文档类型有独立策略：`auto_update`、`mark_stale`、`prompt`、`ignore`。

**能用于生产环境吗？** DocRelay 处于 beta 阶段（v0.3.x）。DB 层、MCP Server、CLI、git hooks 与 watch 模式均由 239 个自动化测试覆盖，并在 CI（Node 20/22）中持续验证。持续完善中的包括超大规模性能优化与更广泛的语言生态测试。

## 参与贡献

发布历史见 [CHANGELOG.md](CHANGELOG.md)，工程路线图见 [UPGRADE.md](UPGRADE.md)。

```bash
git clone https://github.com/seek-hope/docrel.git
cd docrel
npm install
npm test          # 239 tests
npm run lint      # eslint（flat config）
npm run build     # → dist/
```

## 许可证

MIT
