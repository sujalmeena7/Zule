# zule



## Auto-Memory Rule
After completing any task, append a one-line entry to `agent-memory/context/project-context.md`:
`- YYYY-MM-DD: [brief description of what was done]`

## Project Structure
```
agent-memory/
  context/     ← project context and progress logs
  tasks/       ← task specifications and briefs
  handoffs/    ← agent-to-agent handoff notes
  decisions/   ← architecture and design decisions
  bugs/        ← known bugs and fixes
  agents/      ← per-agent configs and checkpoints
```

## Working Directory
All work should stay within: `C:\project\zule`

## Rules
- Do NOT modify files outside this project directory
- Keep agent-memory/ up to date after every task
- Write descriptive commit messages