# Agents for zule


## Runners
| Runner | CLI | Best for |
|--------|-----|----------|
| Claude Code | `claude` | Planning, review, complex reasoning |
| Codex | `codex` | Implementation, refactoring |
| Kiro | `kiro-cli` | Agentic tasks, file management |

## Memory
- Context: `agent-memory/context/`
- Always append progress to `agent-memory/context/project-context.md`

## Workflow
1. Read context from `agent-memory/context/`
2. Execute the assigned task
3. Update `agent-memory/context/project-context.md`