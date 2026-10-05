# Conductor Workflow

Spec-driven development using conductor tracks.

## Overview

Each track represents a user-facing feature or major milestone. Tracks have:
- **spec.md** — Acceptance criteria
- **plan.md** — Implementation tasks (Red → Green → Refactor TDD cycle)
- **metadata.json** — Track metadata

## Track Lifecycle

A track's location in the directory tree **is** its status. There is no separate status field
to keep in sync.

| Folder | Meaning | Exit criteria |
|---|---|---|
| `active/` | In progress. **Max one at a time.** | All plan tasks done and every spec criterion met -> `closed/` |
| `backlog/` | Understood and specced, not current priority | Becomes highest-value work -> `active/` |
| `blocked/` | Cannot proceed; needs something outside its scope | Blocker resolved -> `active/` or `backlog/` |
| `closed/` | Complete. Kept for history, not maintained | — |

Two active tracks means two half-built systems and no decision point. Enforce the limit.

`blocked/` is deliberately distinct from `backlog/`: unstarted work is backlog; work that
*cannot proceed* is blocked. Every blocked track records what is blocking it, who can unblock
it, what was already tried, and whether a workaround exists.

## Naming Convention

`NNN-kebab-case-slug` — zero-padded sequence number for ordering, slug describing the work.

```
001-core-architecture
002-observability-alerting
003-funding-harvesting
```

The earlier `phase-1` / `phase-1.5` / `phase-2-aave` scheme is retired. It encoded a fixed
delivery order that no longer holds: the active track is not "phase 2" in any meaningful
sense — it is a different strategy, on a different chain, against a different venue.

**Do not rename a track directory when it changes state.** Moving `active/` -> `backlog/`
keeps the sequence number and git history coherent; renaming would renumber the project for
no benefit.

## Planning Phase
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

Tracks are grouped by state. A track's folder location is its status.

```
conductor/
├── tracks.md                          # Index
├── workflow.md                        # This file
└── tracks/
    ├── active/
    │   └── 003-funding-harvesting/    # In progress, max 1
    │       ├── spec.md                # Acceptance criteria
    │       ├── plan.md                # Implementation tasks
    │       └── metadata.json          # Track metadata
    ├── backlog/
    │   └── 002-observability-alerting/
    │       └── README.md              # Why each track is waiting
    ├── blocked/
    │   └── README.md                  # What qualifies as blocked
    └── closed/
        └── 001-core-architecture/
            ├── spec.md
            ├── plan.md
            └── metadata.json
```

Each state folder has a `README.md` defining its entry and exit criteria and listing its
contents.

## Example: 003-funding-harvesting

The most complete example is
[`tracks/backlog/003-funding-harvesting/spec.md`](tracks/backlog/003-funding-harvesting/spec.md).
It is in `backlog` rather than `closed` because its Stage 1 gate was never run — an unstarted
track and an unfinished one are different states, and this one is fully specced.

For a closed track with verified completion,
[`tracks/closed/001-core-architecture/`](tracks/closed/001-core-architecture/).
