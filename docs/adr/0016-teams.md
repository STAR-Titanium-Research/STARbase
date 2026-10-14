# ADR-0016 — Teams: a second kind of grantee, owner-approved joiners, and team grants expanded into derived access rows

- **Status:** Proposed (2026-10-14)
- **Date:** 2026-10-14
- **Deciders:** Maintainer + Claude (spec `docs/superpowers/specs/2026-10-14-people-and-teams-design.md`)
- **Amends:** [ADR-0014](./0014-record-access.md)
- **Amended 2026-10-14 (plan 2, while building PR 2):** decisions 2 and 3 as built, see below and spec section 10 (E10 to E14).

## Context

ADR-0014 lets an owner give named people Can view or Can edit on a record. The maintainer asked for **teams** that can be
given access the way Google Groups can, and that can own samples, campaigns, operations and tests. Anyone may create a team,
and its **team managers** decide who is in it. In Google's model, adding someone to a group gives them everything the group can
see. Here that would let a team manager widen access to records they do not own, Restricted ones included, which breaks
ADR-0014 decision 5 (only the owner controls who has access). The maintainer refused that.

ADR-0014 also left update, delete and manage as Directus filters through `access._some.person_id.user_id`. Directus 11.17 cannot
express "through a team" in those filters: the hop from a team to its members is a to-many hop inside `_some`, which it refuses.

## Decision

1. **A team is a second kind of grantee, not a person.** It gets its own `teams` / `team_members` tables, and a grant of its own per
   record (`<type>_team_access`, decision 3; the first version had each of the five access tables name one person or one team, as built they
   stay person-keyed). A team is not a People row: that would have put teams in every person
   picker (owners, operators, PI) and in migration 169's own-row rule.
2. **Owner-approved joiners.** Sharing a record with a team covers its members at that moment, and the owner can see them when
   sharing. Someone who joins later gets access to that record only when its owner approves, or when the owner ticked **Trust
   future members** on that record's team entry. Leaving removes access at once. Approval is asked only when it would raise
   the person's access. The state is kept per grant and per member (as built: derived rows for active members and five
   `<type>_team_pending` tables for waiting and declined ones, decision 3), maintained by triggers so that every writer obeys it.
   ADR-0014 decision 5 therefore still holds: only a record's owner (for a team-owned
   record, the team's managers) widens its access.
3. **A team grant is expanded into derived access rows (amended; this replaces the editors and managers tables).** The ADR first
   said edit and manage rights would be materialised in `<type>_editors` and `<type>_managers` tables beside the readers, computed by new
   function families, with every Directus update, delete and manage rule rewritten to one `_some` test. **As built (Ruling D1), a team
   grant (`<type>_team_access`: team, level, Trust future members) is expanded by triggers into ordinary `<type>_access` rows, one per
   active member, tagged with `team_access_id`.** Waiting and declined members have a row in `<type>_team_pending` instead. Everything
   that already reads access rows by person covers teams unchanged: the readers functions and tables, the Restricted cascades, the Lab
   Member update and delete filters (`access._some.person_id.user_id` with a role), Ask-DB row security; `scripts/access_rules.json` and
   the Directus rules do not change. A guard trigger refuses any write to a derived row except by the bookkeeping (and foreign-key
   cascades), and `d1_private.team_drift()` checks them. **Reason:** the editors and managers design needed a new generator item kind, new
   aliases in three places, editors oracles that do not exist and a rewrite of every Lab Member update and delete rule, all gated by a
   rights matrix that CI does not run; derived rows reuse the proven readers machinery and the existing edit filters, and keep the
   data model person-keyed. Whether an approval is asked is decided by `team_pending_actionable()` (Rulings D2, D2a, D2b: only while
   approving would raise the person's access), not stored. Team ownership (PR 3) uses the same mechanism: owning-team members get `edit`
   and the managers a new `manage` level through an `owner` pseudo-grant, so the owner and delete rules gain one item kind, not a table family.
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
- **Editors and managers tables (the first version of decision 3).** Rejected while building PR 2 for the reason in decision 3: more
  machinery than expanding the grant into rows the system already reads.

## Consequences

- The access tables hold one extra row per member and team grant (a team of 20 on 100 records is 2000 rows) and a new column
  `team_access_id`; `UNIQUE (record, person_id)` became two partial unique indexes. The rights functions, the oracle and the Directus rules do not
  change in PR 2 (the readers update triggers also compare `team_access_id`); after a restore the derived rows are checked with `d1_private.team_drift()` (0 rows) next to the readers'
  `readers_drift_count()`.
- A derived row cannot be edited by hand, even by an Administrator in Data Studio; the grant is changed instead. The guard is not a
  security boundary (a session that can run SQL can lift it).
- A write that changes membership or a grant writes derived rows and recomputes the readers tables of the affected records once per
  statement. It is measured against A1a's gate (p95 below 300 ms per list, writes at most 2x) and by the two scenarios
  `team_join_100_records` and `team_grant_20_members` (each under 500 ms).
- Known gaps are in spec section 7: a parent delete racing a member or grant insert can abort one with 40P01; a logo file can be
  overwritten through `/files`; pending and declined names are visible to every reader of the record.
- Owners carry a small queue of approvals, with one email per joiner and a Home card.
- Administrators editing membership in Data Studio still get the bookkeeping and history from the triggers, but no emails.
