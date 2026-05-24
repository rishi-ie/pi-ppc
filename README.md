# PI Project Context

> A persistent project brain for coding agents — local, inspectable, version-controlled.

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## What is PI?

PI is a **Claude-Code-like project memory system** that gives coding agents persistent, structured context about your project. Every project gets a local `.pi/` directory that acts as its "project brain" — no databases, no vector embeddings, just clean local files.

The core principle:

> **Chat history ≠ memory**
>
> Memory should be explicit, structured, file-based, inspectable, editable, and version-controllable.

## Why PI?

Traditional agent sessions start with a blank slate. PI changes that:

| Without PI | With PI |
|------------|---------|
| Agent forgets everything between sessions | Agent has persistent project memory |
| Decisions buried in Slack/DM/chat | Decisions tracked in `.pi/architecture/decisions.md` |
| Context scattered across readmes | Context assembled from structured files |
| New agent must re-learn codebase | New agent reconstructs context from graphs |

## Project Structure

```
.pi/                          # Your project's persistent brain
├── identity/                 # Who is this project?
│   ├── vision.md            # What are we building?
│   ├── goals.md             # What are we trying to achieve?
│   └── constraints.md       # What constraints exist?
│
├── architecture/             # How is it built?
│   ├── system_overview.md   # High-level architecture
│   ├── decisions.md         # ADRs (Architecture Decision Records)
│   ├── patterns.md          # Established design patterns
│   └── interfaces.md        # Public APIs
│
├── memory/                   # What do we know?
│   ├── semantic/            # Entities, concepts, relations
│   │   ├── entities.json
│   │   ├── concepts.json
│   │   └── relations.json
│   ├── episodic/            # What happened?
│   │   ├── events.jsonl     # Event stream
│   │   └── sessions/        # Session archives
│   └── procedural/          # How do we work?
│       ├── workflows.md
│       └── coding_rules.md
│
├── state/                    # What are we working on?
│   ├── current_focus.json   # Current task focus
│   ├── active_tasks.json    # Task list
│   ├── open_questions.json  # Unanswered questions
│   └── roadmap.json        # Milestones
│
├── graph/                    # What depends on what?
│   ├── symbol_graph.json     # Classes, functions, types
│   ├── dependency_graph.json # npm packages
│   └── file_graph.json       # Import relationships
│
├── summaries/               # Auto-generated summaries
│   ├── project_summary.md
│   ├── architecture_summary.md
│   └── recent_state.md
│
├── world_model/              # What do we believe?
│   ├── beliefs.json          # Inferred beliefs
│   ├── assumptions.json     # Working assumptions
│   └── confidence.json      # Confidence levels
│
└── cache/                    # Cached data
```

## Quick Start

### Installation

```bash
npm install -g pi-ppc
# or
npm install pi-ppc
```

### Initialize a Project

```bash
pi init
```

This creates the `.pi/` directory structure with starter templates.

### Core Commands

```bash
# Build runtime context for a new session
pi context

# Show project status
pi status

# Update symbol/dependency/file graphs
pi sync

# Display memory (beliefs, decisions, entities)
pi memory

# Distill recent activity into memory
pi summarize
```

## Commands in Detail

### `pi init`

Initializes the `.pi/` directory structure. Safe to run multiple times — merges with existing structure.

```bash
pi init --verbose
```

### `pi context`

Builds a complete runtime context by loading:
1. Identity (vision, goals, constraints)
2. Architecture summaries
3. State (focus, tasks, questions)
4. Recent episodic memory
5. Semantic memory
6. Code graph context
7. Recent changes

```bash
# Full context as JSON
pi context --json

# Find relevant memories about a topic
pi context --relevant "authentication"
```

### `pi status`

Displays a visual dashboard of project state:

```
┌──────────────────────────────────────────────────┐
│             Project Status                        │
└──────────────────────────────────────────────────┘

📍 Current Focus
──────────────────────────────
  Implementing user authentication

📋 Active Tasks
──────────────────────────────
  🔄 In Progress (2):
     • Add OAuth2 support
     • Create login page
  ⏳ Pending (5):
     • Add password reset flow
     • ...

📊 Progress
──────────────────────────────
  Tasks: [████░░░░░░] 40% (2/5)
  Events: 47
  Sessions: 12
```

### `pi sync`

Updates all knowledge graphs:

- **Symbol graph**: Extracts classes, functions, interfaces, types
- **Dependency graph**: Maps npm packages and versions
- **File graph**: Tracks import relationships

```bash
# Full sync
pi sync --verbose

# Only update symbol graph
pi sync --scope symbol
```

### `pi memory`

Displays accumulated knowledge:

```bash
# All memory sections
pi memory

# Specific sections
pi memory --section beliefs
pi memory --section entities
pi memory --section decisions
pi memory --section events
pi memory --section assumptions
```

### `pi summarize`

Compresses recent session activity into distilled knowledge:

```
Raw sessions
    ↓
extract decisions → update decisions.md
extract entities  → update entities.json
extract tasks    → update active_tasks.json
extract assumptions → update world_model/
    ↓
update summaries
    ↓
discard excess raw history
```

## Architecture

```
src/
├── core/                      # Core engines
│   ├── context-engine/        # Builds RuntimeContext
│   ├── graph-engine/          # Extracts code graphs
│   ├── memory-engine/         # Extracts & distills knowledge
│   └── types.ts               # TypeScript interfaces
│
├── cli/                       # CLI commands
│   ├── init.ts
│   ├── context.ts
│   ├── status.ts
│   ├── sync.ts
│   ├── memory.ts
│   └── summarize.ts
│
└── integrations/              # Integration points
    ├── vscode.ts              # VS Code extension hooks
    └── git.ts                 # Git integration
```

## Design Principles

1. **Local-first** — Everything stored locally, no external services
2. **File-based** — Human-readable, git-friendly, easy to edit
3. **No databases** — Plain JSON/JSONL/Markdown files
4. **No vector stores** — Keyword matching for retrieval
5. **Model-agnostic** — Works with any LLM backend
6. **Deterministic** — Same input always produces same output
7. **Inspectable** — All state visible and editable

## File Formats

### JSON State Files

```json
{
  "focus": "Implement auth",
  "focus_since": "2024-05-20T10:00:00Z",
  "priority": "high"
}
```

### JSONL Event Stream

```jsonl
{"id":"evt-001","type":"decision","timestamp":"...","summary":"Use JWT for auth","session_id":"sess-abc"}
{"id":"evt-002","type":"task","timestamp":"...","summary":"Created auth.ts","session_id":"sess-abc"}
```

### Markdown Documents

Plain Markdown with structured sections for:
- Architecture decisions
- Design patterns
- Coding rules
- Workflow documentation

## Use Cases

### For Individual Developers

- Maintain context across sessions
- Track architectural decisions
- Keep task state persistent

### For Development Teams

- Share project knowledge via git
- Onboard new team members quickly
- Track decisions and rationale

### For AI Coding Agents

- Reconstruct project understanding from `.pi/`
- Make informed decisions based on history
- Maintain consistent behavior across sessions

## Contributing

Contributions welcome! Please read the code structure and follow the patterns:

- Core logic lives in `src/core/`
- CLI commands are in `src/cli/`
- All state is file-based (no databases)
- Types are defined in `src/core/types.ts`

## License

MIT