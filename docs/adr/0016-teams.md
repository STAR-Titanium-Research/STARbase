# ADR-0016 — Teams: a second kind of grantee, owner-approved joiners, and materialised edit and manage rights

- **Status:** Proposed (2026-10-14)
- **Date:** 2026-10-14
- **Deciders:** Maintainer + Claude (spec `docs/superpowers/specs/2026-10-14-people-and-teams-design.md`)
- **Amends:** [ADR-0014](./0014-record-access.md)

## Context

ADR-0014 lets an owner give named people Can view or Can edit on a record. The maintainer asked for **teams** that can be
given access the way Google Groups can, and that can own samples, campaigns, operations and tests. Anyone may create a team,
and its **team managers** decide who is in it. In Google's model, adding someone to a group gives them everything the group can
see. Here that would let a team manager widen access to records they do not own, Restricted ones included, which breaks
ADR-0014 decision 5 (only the owner controls who has access). The maintainer refused that.

ADR-0014 also left update, delete and manage as Directus filters through `access._some.person_id.user_id`. Directus 11.17 cannot
express "through a team" in those filters: the hop from a team to its members is a to-many hop inside `_some`, which it refuses.

## Decision

1. **A team is a second kind of grantee, not a person.** It gets its own `teams` / `team_members` tables. Each of the five
   access tables names exactly one person or one team. A team is not a People row: that would have put teams in every person
   picker (owners, operators, PI) and in migration 169's own-row rule.
2. **Owner-approved joiners.** Sharing a record with a team covers its members at that moment, and the owner can see them when
   sharing. Someone who joins later gets access to that record only when its owner approves, or when the owner ticked **Trust
   future members** on that record's team entry. Leaving removes access at once. Approval is asked only when it would raise
   the person's access. The state is kept per grant and per member in five `<type>_access_members` tables, maintained by
   triggers so that every writer obeys it. ADR-0014 decision 5 therefore still holds: only a record's owner (for a team-owned
   record, the team's managers) widens its access.
3. **Edit and manage rights are materialised like the readers.** `<type>_editors` and `<type>_managers` sit beside
   `<type>_readers`. They are computed by function families next to `readers_of_<type>()`, kept by the same triggers under the
   same lock, and covered by the same drift check, rebuild and oracle. Each Directus update, delete and manage rule becomes a
   single `_some` membership test.
4. A team can **own** a sample, campaign, operation or test, and its managers act as the owner. It can be an **Investigator**
   on a project but never its PI. A team that owns records cannot be deleted.

## Considered options

- **A team as a special People row.** Rejected: teams would appear in about nine person pickers and the PI field, each needing
  a guard.
- **Live membership with no approval (Google's model).** Rejected: a team manager could widen access to records they do not
  own.
- **Admins own membership.** Rejected: the maintainer wants anyone to be able to run a team.
- **Restricted records refuse teams.** Rejected: it only partly closes the gap.
- **Snapshot on share.** Rejected: it loses live membership; leaving would no longer remove access.
- **Edit rules through team filters.** Not possible in Directus 11.17.

## Consequences

- Every rights function, the oracle and the readers matrix gain team branches and two new outputs (editors, managers). The
  derived tables need a `rights_rebuild()` after any restore, as the readers do.
- Writes that change membership refresh three tables per affected record instead of one. They are measured against A1a's gate.
- Owners carry a small queue of approvals, with one email per joiner and a Home card.
- Administrators editing membership in Data Studio still get the bookkeeping and history from the triggers, but no emails.
