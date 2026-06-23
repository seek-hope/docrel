# DocRel — Code-Documentation Relational Sync

[![Tests](https://img.shields.io/badge/tests-50%20passed-brightgreen)](https://github.com/seek-hope/docrel/actions)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Treat documentation like a database.** DocRel applies relational database concepts — foreign keys, CASCADE updates, CHECK constraints — to keep code and documentation in sync automatically. No manual annotations required.

When you refactor code, DocRel tells your AI agent (or you) exactly which documentation sections need updating, and can even apply the changes automatically.

## How It Works

```
┌──────────┐     ┌──────────────┐     ┌──────────┐
│  Code    │────▶│   DocRel     │────▶│   Docs   │
│ changes  │     │  .docrel.db  │     │ updated  │
└──────────┘     └──────┬───────┘     └──────────┘
                        │
                 ┌──────▼───────┐
                 │  Codegraph   │
                 │  (symbol     │
                 │   tracking)  │
                 └──────────────┘
```

| Database Concept | DocRel Equivalent |
|-----------------|-------------------|
| Primary Key | Stable Symbol ID — `SHA256(lang:fqn:kind)` stays constant across renames |
| Foreign Key | Symbol ↔ Doc Section mapping (JOIN table) |
| ON UPDATE CASCADE | Code change → auto-update linked docs (configurable per doc type) |
| CHECK constraint | Git hooks prevent commits with stale documentation |
| WAL Log | Full changelog tracking every symbol mutation |

DocRel uses [Codegraph](https://github.com/codegraph-ai/CodeGraph) to track symbols across renames and file moves — documentation links survive refactoring.

## Quick Start

### Installation

```bash
npm install -g docrel
```

### First Use in a Project

```bash
cd your-project

# Initialize (creates .docrel/config.yaml)
docrel status

# Install git hooks (enforce doc sync on commit/push)
docrel install-hooks

# Scan codebase and discover symbols
docrel scan

# Check documentation health
docrel status
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `docrel status` | Health dashboard — symbol count, doc sync %, stale docs |
| `docrel check` | List stale documentation. `--strict` exits code 1 for CI |
| `docrel impact <files...>` | Show which docs are affected by changed files |
| `docrel sync --symbol <id>` | CASCADE-update docs linked to a symbol |
| `docrel link create --symbol <id> --doc <id>` | Create a manual mapping |
| `docrel diff <symbol_id>` | View change history for a symbol |
| `docrel export-mappings` | Export `.docrel/mappings.json` for CodeGraph integration |
| `docrel install-hooks` | Install pre-commit, post-commit, pre-push hooks |

### MCP Server (AI Agent Integration)

Add to your agent's MCP configuration:

```json
{
  "mcpServers": {
    "docrel": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "DOCREL_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

DocRel exposes 6 MCP tools mirroring the CLI: `docrel_status`, `docrel_check`, `docrel_impact`, `docrel_sync`, `docrel_link`, `docrel_diff`.

### Configuration (`.docrel/config.yaml`)

```yaml
project: my-project
doc_dirs:
  - docs
  - README.md
code_dirs:
  - src
strategies:
  inline: auto_update       # Docstrings in source — rewrite directly
  standalone: auto_update   # Markdown docs — generate diff, agent reviews
  generated: auto_update    # TypeDoc/OpenAPI — re-run generator
  architecture: mark_stale  # Architecture docs — flag for review only
```

## End-to-End Example

```
User: "Rename login() to authenticate() across the project"

Agent calls: docrel_impact(paths=["src/auth.ts"])
→ Returns:
  - 1 symbol affected: login (function)
  - 3 docs linked:
    • src/auth.ts (inline docstring) — will be auto-updated
    • docs/api.md § Authentication (standalone) — will be rewritten
    • docs/architecture/security.md (architecture) — will be marked stale

Agent refactors code → login() → authenticate()

Agent calls: docrel_sync("auth:login")
  ├─ Inline docstring ✅ updated in src/auth.ts
  ├─ docs/api.md section ✅ rewritten with new signature
  └─ docs/architecture/security.md ⚠️ marked stale

Pre-commit hook: docrel_check --strict
→ security.md is stale → User decides to review

Commit auto-annotated:
  DocRel: 1 symbol changed, 2 docs synced, 1 doc flagged for review
```

### Git Hook Behavior

| Hook | Action |
|------|--------|
| **pre-commit** | `docrel check --quick` — blocks commit if staged files have stale docs |
| **post-commit** | `docrel impact` — marks affected docs as stale for next session |
| **pre-push** | `docrel check --strict` — blocks push with stale documentation |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: Agent Adapter                   │
│  Claude Code (MCP)  │  OpenCode (MCP)  │  Any Agent (CLI)  │
├─────────────────────────────────────────────────────────────┤
│                    Layer 2: DocRel Core                     │
│  Impact Analyzer  │  CASCADE Engine  │  Git Hooks          │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: Data Store                      │
│  .git/docrel.db (SQLite)  │  .docrel/ config & mappings     │
├─────────────────────────────────────────────────────────────┤
│                    Layer 0: Symbol Backend                  │
│              Codegraph (symbol identity tracking)           │
└─────────────────────────────────────────────────────────────┘
```

### Project Structure

```
src/
├── index.ts              # MCP Server entry (6 tools, stdio transport)
├── cli.ts                # CLI entry (8 commands, commander.js)
├── db/                   # SQLite data layer
│   ├── connection.ts     # Singleton connection (WAL mode, FK enabled)
│   ├── schema.ts         # 4 tables + indexes + migrations
│   ├── symbols.ts        # CRUD for code symbols
│   ├── docs.ts           # CRUD for documentation sections
│   └── mappings.ts       # FK join table + JSON export
├── codegraph/client.ts   # Codegraph MCP stdio client
├── discovery/scanner.ts  # Auto-discover symbols from codegraph index
├── sync/                 # CASCADE sync strategies
│   ├── engine.ts         # Orchestrator — routes by doc_type
│   ├── inline.ts         # Docstring/JSDoc updater
│   ├── standalone.ts     # Markdown section rewriter
│   └── generated.ts      # Generator trigger (TypeDoc, OpenAPI)
├── tools/                # MCP tool handlers
│   ├── status.ts, check.ts, impact.ts, sync.ts, link.ts, diff.ts
├── git/hooks.ts          # pre-commit, post-commit, pre-push logic
└── utils/                # hash.ts (SHA256 IDs), config.ts (YAML parser)
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (ES2023, NodeNext, ESM) |
| MCP Server | `@modelcontextprotocol/sdk` |
| Database | SQLite via `better-sqlite3` |
| Symbol Backend | Codegraph MCP Server (`codegraph-ai/CodeGraph`) |
| CLI | `commander` |
| Git | `simple-git` + native hooks |
| Tests | `vitest` (50 tests, 9 suites) |

## Codegraph Integration

DocRel uses [Codegraph](https://github.com/codegraph-ai/CodeGraph) as its symbol intelligence backend:

- **Auto-discovery**: Scans codegraph index to populate the `symbols` table
- **Change tracking**: Detects signature changes via codegraph's symbol identity
- **Impact analysis**: Uses `codegraph_analyze_impact` to find affected docs
- **`doc_refs` field**: A [lightweight PR](https://github.com/codegraph-ai/CodeGraph/pull/6) adds `doc_refs` to CodeGraph's impact response — reads `.docrel/mappings.json` if present

```bash
# Generate the file CodeGraph reads:
docrel export-mappings
# → writes .docrel/mappings.json

# Now codegraph_analyze_impact responses include:
# "doc_refs": [{"doc_file": "docs/api.md", "symbol_name": "login", ...}]
```

## FAQ

**Do I need to annotate my code?** No. DocRel is zero-annotation. Codegraph discovers symbols, DocRel parses docs for code references, and mappings are built automatically.

**What languages are supported?** DocRel itself is language-agnostic. The codegraph backend supports 37+ languages (TypeScript, Python, Rust, Go, Java, C/C++, etc.).

**What if I don't use an AI agent?** DocRel works standalone. The CLI gives you full visibility into doc health. Git hooks enforce consistency without any agent.

**Can I customize sync behavior?** Yes. Each doc type (inline, standalone, generated, architecture) has its own strategy in `.docrel/config.yaml` — choose between `auto_update`, `mark_stale`, `prompt`, or `ignore`.

**Is this ready for production?** DocRel is in early development (v0.1.0). The core DB layer, MCP server, and CLI are solid. Areas still maturing: file watcher integration, performance at scale, and broader language ecosystem testing.

## Contributing

See [docs/superpowers/specs/2026-06-23-docrel-design.md](docs/superpowers/specs/2026-06-23-docrel-design.md) for the full design spec and [docs/superpowers/plans/2026-06-23-docrel-implementation.md](docs/superpowers/plans/2026-06-23-docrel-implementation.md) for the implementation plan.

```bash
git clone https://github.com/seek-hope/docrel.git
cd docrel
npm install
npm test          # 50 tests
npm run build     # → dist/
```

## License

MIT

---

# DocRel — 代码与文档的关系型同步系统

**像管理数据库一样管理文档。** DocRel 将关系型数据库的概念——外键、级联更新（CASCADE）、CHECK 约束——应用于代码与文档的同步。无需手动标注。

当你重构代码时，DocRel 会告诉你的 AI Agent（或你自己）哪些文档段落需要更新，甚至可以自动完成更新。

## 核心理念

> 数据库靠外键保证引用完整性——代码和文档为什么不能？

| 数据库概念 | DocRel 实现 |
|-----------|------------|
| 主键 (PK) | 稳定符号 ID — `SHA256(语言:全限定名:类型)`，重命名/移动文件后 ID 不变 |
| 外键 (FK) | 符号 ↔ 文档段落映射表（JOIN 表） |
| ON UPDATE CASCADE | 代码变更 → 自动更新关联文档（按文档类型可配置策略） |
| CHECK 约束 | Git hooks 在提交/推送前校验文档同步状态 |
| WAL 日志 | 完整的变更日志追踪每次符号修改 |

DocRel 使用 [Codegraph](https://github.com/codegraph-ai/CodeGraph) 追踪符号的重命名和文件移动——文档关联在重构后依然存活。

## 快速开始

### 安装

```bash
npm install -g docrel
```

### 在项目中使用

```bash
cd your-project

# 初始化（创建 .docrel/config.yaml）
docrel status

# 安装 git hooks（提交/推送时强制文档同步）
docrel install-hooks

# 扫描代码库发现符号
docrel scan

# 查看文档健康度
docrel status
```

### CLI 命令一览

| 命令 | 描述 |
|------|------|
| `docrel status` | 健康仪表盘 — 符号数、关联率、文档同步率 |
| `docrel check` | 列出过期文档。`--strict` 时退出码为 1（CI 友好） |
| `docrel impact <文件...>` | 展示哪些文档受代码变更影响 |
| `docrel sync --symbol <id>` | CASCADE 更新某个符号关联的文档 |
| `docrel link create --symbol <id> --doc <id>` | 手动创建映射 |
| `docrel diff <符号id>` | 查看符号的变更历史 |
| `docrel export-mappings` | 导出 `.docrel/mappings.json` 供 CodeGraph 集成 |
| `docrel install-hooks` | 安装 pre-commit / post-commit / pre-push hooks |

### MCP Server 用法

在 Agent 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "docrel": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "DOCREL_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

DocRel 提供 6 个 MCP 工具（与 CLI 对应）：`docrel_status`、`docrel_check`、`docrel_impact`、`docrel_sync`、`docrel_link`、`docrel_diff`。

### 配置（`.docrel/config.yaml`）

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

Agent 调用: docrel_impact(paths=["src/auth.ts"])
→ 返回:
  - 1 个符号受影响: login (函数)
  - 3 份关联文档:
    • src/auth.ts (内联注释) — 将自动更新
    • docs/api.md § 认证 (独立文档) — 将重写段落
    • docs/architecture/security.md (架构文档) — 标记过期

Agent 重构代码 → login() → authenticate()

Agent 调用: docrel_sync("auth:login")
  ├─ 内联注释 ✅ 已在 src/auth.ts 中更新
  ├─ docs/api.md 段落 ✅ 已用新签名重写
  └─ docs/architecture/security.md ⚠️ 已标记为 stale

pre-commit hook: docrel_check --strict
→ security.md 已过期 → 用户决定审查后更新

提交信息自动附加:
  DocRel: 1 个符号变更，2 份文档已同步，1 份文档待审查
```

### Git Hook 行为

| Hook | 行为 |
|------|------|
| **pre-commit** | `docrel check --quick` — 暂存文件关联文档过期则阻止提交 |
| **post-commit** | `docrel impact` — 标记受影响文档为过期 |
| **pre-push** | `docrel check --strict` — 有过期文档则阻止推送 |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: Agent 适配层                    │
│  Claude Code (MCP)  │  OpenCode (MCP)  │  任意 Agent (CLI) │
├─────────────────────────────────────────────────────────────┤
│                    Layer 2: DocRel 核心                     │
│  影响分析器  │  CASCADE 引擎  │  Git Hooks                 │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: 数据存储                        │
│  .git/docrel.db (SQLite)  │  .docrel/ 配置 & 映射          │
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
| 符号后端 | Codegraph MCP Server (`codegraph-ai/CodeGraph`) |
| CLI | `commander` |
| Git | `simple-git` + 原生 hooks |
| 测试 | `vitest`（50 测试，9 套件，~4700 行源码） |

## 常见问题

**需要手动标注代码吗？** 不需要。DocRel 是零标注的。Codegraph 自动发现符号，DocRel 解析文档中的代码引用，映射自动建立。

**支持哪些语言？** DocRel 本身是语言无关的。Codegraph 后端支持 37+ 种语言。

**不用 AI Agent 能用吗？** 可以用。CLI 提供完整的文档健康可见性。Git hooks 独立于 Agent 强制执行一致性。

**可以自定义同步策略吗？** 可以。每种文档类型有独立策略：`auto_update`、`mark_stale`、`prompt`、`ignore`。

**能用于生产环境吗？** DocRel 处于早期开发阶段（v0.1.0）。核心 DB 层、MCP Server 和 CLI 已稳定可用。持续完善中的包括文件监听集成、大规模性能优化、更广泛的语言生态测试。

## 参与贡献

完整设计文档见 [docs/superpowers/specs/2026-06-23-docrel-design.md](docs/superpowers/specs/2026-06-23-docrel-design.md)，实现计划见 [docs/superpowers/plans/2026-06-23-docrel-implementation.md](docs/superpowers/plans/2026-06-23-docrel-implementation.md)。

```bash
git clone https://github.com/seek-hope/docrel.git
cd docrel
npm install
npm test          # 50 tests
npm run build     # → dist/
```

## 许可证

MIT
