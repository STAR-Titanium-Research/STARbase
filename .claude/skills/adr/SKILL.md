---
name: adr
description: Use when a D1-Database change makes a significant or hard-to-reverse decision (a new service, storage or auth model, a schema pattern, swapping a dependency, superseding an earlier ADR), or when a substantial feature needs a design spec before it is built. Writes the ADR in docs/adr/ or the spec in docs/superpowers/specs/ and updates the matching index table.
argument-hint: [decision or feature]
---

# Decision records and design specs

CONTRIBUTING requires an ADR in the **same PR** as any significant or hard-to-reverse decision,
and a design spec for any substantial feature. They exist so a later session can learn *why*
the system is this way without arguing the decision again. Write for that reader.

Topic: `$ARGUMENTS`

## ADR or spec?

| Write an **ADR** (`docs/adr/`) when… | Write a **spec** (`docs/superpowers/specs/`) when… |
|---|---|
| The choice constrains future work across the system | You are designing one feature: its UI, data flow and components |
| Reversing it later would be expensive | The open questions are about *how*, not *whether* |
| e.g. Postgres as the core, trigger-based audit, guarded text-to-SQL | e.g. FRM filtering suite, diagnostics workbench |

A feature can need both: the spec for the feature, an ADR for the one architectural choice inside it.

## Existing records

ADRs: !`ls docs/adr | grep -E '^[0-9]{4}-' | tr '\n' ' '`

Recent specs: !`ls docs/superpowers/specs | tail -4 | tr '\n' ' '`

## ADR

- File: `docs/adr/NNNN-kebab-title.md`, using the next number after the list above.
- Header lines, then sections, matching `0009-text-to-sql-guarded-readonly.md`:
  ```
  # ADR-NNNN — Title
  - **Status:** Proposed | Accepted | Superseded by ADR-XXXX
  - **Date:** YYYY-MM-DD
  - **Deciders:** Maintainer + Claude (<phase or track>)
  ## Context        — the forces and constraints, with spec / plan.md references
  ## Decision       — what was chosen, concretely enough to implement
  ## Alternatives considered — each option and why it lost
  ## Consequences   — what gets easier, what gets harder, what's now forbidden
  ## Verification   — the tests or checks that hold the decision in place (optional)
  ## References     — ADRs, specs, migrations, files
  ```
- Add a row to the table in `docs/adr/README.md`.
- **Superseding** an ADR: don't rewrite the old one. Set its status to `Superseded by ADR-NNNN`,
  add a short `## Update — superseded by …` section at its top (see ADR-0004), and update both
  rows in the README table.

## Spec

- File: `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`.
- Open with `**Date:**` and `**Status:**` lines. The status says *design only*, *in progress* or
  *implemented YYYY-MM-DD* and where the code lives. Then the sections the feature needs. The
  common ones here are: Why / Problem, Goals, Non-goals, Architecture or Components, Data model
  (with migration names), Error handling, Testing.
- Add a row to the table in `docs/superpowers/README.md`.
- A step-by-step implementation plan, if you write one, goes in `docs/superpowers/plans/` and is
  **deleted** once the feature ships. The spec stays.

## Gotchas

- Specs and ADRs are cited from code, migrations and config, so **don't rename or move** an
  existing one.
- When a feature ships, update the spec's Status line *and* its row in the README table. They drift
  when only one is changed.
- Name the real files, tables and migrations. "The worker writes results back" is less useful to
  a later reader than "`analysis-worker` read-merge-writes its own namespaced key into
  `test_sessions.summary_stats`".
- Check `plan.md` for the current phase. A decision that belongs to a later phase should be
  recorded as `Proposed`, not built.
