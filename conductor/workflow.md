# Conductor Workflow

Spec-driven development using conductor tracks.

## Track Lifecycle

A track's location in the directory tree **is** its status.

| Folder | Meaning | Exit criteria |
|---|---|---|
| `active/` | In progress. Max one at a time. | All plan tasks done and every spec criterion met → `closed/` |
| `backlog/` | Understood and specced, not current priority | Becomes highest-value work → `active/` |
| `blocked/` | Cannot proceed; needs something outside its scope | Blocker resolved → `active/` or `backlog/` |
| `closed/` | Complete. Kept for history, not maintained | — |

## Naming Convention

`NNN-kebab-case-slug` — zero-padded sequence number for ordering, slug describing the work.

Track directories are **not** renamed when a track changes state.

## Plan Format

```markdown
# Phase 1 Core

[x] Setup: create project structure
[~] Implement Jev client
[ ] Add execution
```

- `[ ]` — Not started
- `[~]` — In progress
- `[x] <sha>` — Done (with commit SHA when work spans multiple commits)

Tick every task as you go, never batch.
