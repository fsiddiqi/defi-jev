# Conductor Workflow

Spec-driven development using conductor tracks.

## Overview

Each track represents a user-facing feature or major milestone. Tracks have:
- **spec.md** — Acceptance criteria
- **plan.md** — Implementation tasks (Red → Green → Refactor TDD cycle)
- **metadata.json** — Track metadata

## Lifecycle

### Planning Phase
1. Write `spec.md` (what we're building)
2. Write `plan.md` (how we'll build it)
3. Write `metadata.json` (track info)
4. Register in `conductor/tracks.md`
5. Merge to `dev` via short `docs/` branch

### Implementation Phase
1. Create feature branch off latest `dev`
2. Follow `plan.md` sequentially
3. TDD: Red → Green → Refactor for each task
4. Update `plan.md` as you go (tick `[ ]` → `[~]` → `[x]`)
5. Merge to `dev` with `--no-ff` once complete
6. Delete feature branch

### Release Phase
1. Promote `dev` → `main` (user creates PR + merges)
2. Tag release on `main`
3. Archive completed track

## Plan Format

```markdown
# Phase 1 Core

[x] Setup: create project structure
[~] Implement Jev classifier
[ ] Add Aave integration
```

- `[ ]` — Not started
- `[~]` — In progress
- `[x] <sha>` — Done (with commit SHA when work spans multiple commits)

Tick every task as you go, never batch. The user tracks progress by reading the file.

## TDD Cycle

For each task in `plan.md`:

1. **Red**: Write failing test(s)
2. **Green**: Write minimal code to pass
3. **Refactor**: Clean up, extract abstractions
4. Tick `[ ]` → `[x]` (same turn)

## Git Workflow

**Branch naming:** `feat/<track-name>`, `fix/`, `chore/`, `docs/`

**Merging:**
- Feature → dev: `--no-ff` (preserve branch history)
- dev → main: User creates PR (required gate)

**Cleaning up:** Delete feature branch after merge (unless user says keep)

## File Structure

```
conductor/
├── tracks.md                          # Index
├── workflow.md                        # This file
└── tracks/
    ├── phase-1-core/
    │   ├── spec.md                    # Acceptance criteria
    │   ├── plan.md                    # Implementation tasks
    │   └── metadata.json              # Track metadata
    └── phase-2-aave/
        ├── spec.md
        ├── plan.md
        └── metadata.json
```

## Example: phase-1-core

See `conductor/tracks/phase-1-core/spec.md` for a complete example.
