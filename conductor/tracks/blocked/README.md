# Blocked

Tracks that cannot proceed. A track belongs here when something outside the track's own scope
is preventing progress — not merely when it is unstarted (that is `backlog`) or not yet the
highest priority (that is `backlog` too).

## Contents

None.

## What qualifies

A dependency that is not being worked on, and which cannot be worked around:

- An external service, API, or protocol that is unavailable or unreliable
- A credential, key, or capital allocation that has not been provided
- A design decision that needs a stakeholder who is not available
- A blocking defect in an upstream dependency

## Requirements

Every blocked track must record:

1. **What** is blocking it
2. **Who or what** can unblock it
3. **What was already tried** — so the same dead end is not rediscovered
4. **Whether a workaround exists** — if yes, it probably belongs in `backlog` instead

A blocked track with no stated unblock path is indistinguishable from an abandoned one. Keep
that list short and current.

## Exit criteria

Resolve the blocker and move to `active` or `backlog` depending on priority.
