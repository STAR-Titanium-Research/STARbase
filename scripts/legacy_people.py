"""Resolve legacy owner / operator text to ``people`` (and their Directus login).

Since migrations 061/062 the UI reads ``owner_person_id`` / ``operator_person_id`` and
``sample_co_owners.person_id`` (-> ``people``); the older ``owner`` / ``user_id`` columns
(-> ``directus_users``) are kept as a backup, and nothing syncs the two. Scripts that write
ownership therefore have to set both. ``people`` rows map to users through ``people.user_id``
(a person without a login has none), so the person is the thing to resolve first.

Shared by ``migrate_legacy.py`` and ``transfer_sample_ownership.py``. Pure Python plus plain
SQL on a cursor, so it works with psycopg2 or a test double.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Same name expression as migration 060, so a person created here matches one the
# migration would have created for the same user.
_ENSURE_PEOPLE_SQL = """
INSERT INTO people (full_name, email, user_id, is_researcher)
SELECT COALESCE(NULLIF(btrim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
                u.email, 'User ' || u.id::text),
       u.email, u.id, TRUE
FROM directus_users u
WHERE u.id = ANY(%s::uuid[])
  AND NOT EXISTS (SELECT 1 FROM people p WHERE p.user_id = u.id)
"""

_INDEX_SQL = """
SELECT p.person_id::text, p.user_id::text, lower(p.email), lower(u.email), lower(p.full_name)
FROM people p LEFT JOIN directus_users u ON u.id = p.user_id
"""


def norm(text: object) -> str:
    return " ".join(str(text or "").split()).lower()


@dataclass
class PeopleIndex:
    """Lookup of people by email or (unique) full name; empty is valid (dry runs)."""

    by_email: dict[str, str] = field(default_factory=dict)
    by_name: dict[str, str] = field(default_factory=dict)
    user_by_person: dict[str, str] = field(default_factory=dict)

    def person_for(self, text: object) -> str | None:
        """person_id for an email or full name; None when unknown or the name is ambiguous."""
        key = norm(text)
        if not key:
            return None
        return self.by_email.get(key) or self.by_name.get(key)

    def user_for_person(self, person_id: str | None) -> str | None:
        return self.user_by_person.get(person_id) if person_id else None

    def resolve_owner(self, text: object) -> tuple[str | None, str | None]:
        """(legacy user id, person id) to write for an owner given as email or name."""
        person = self.person_for(text)
        return self.user_for_person(person), person


def ensure_people(cur, user_ids: list[str]) -> int:
    """Create a ``people`` row for every listed user that has none; return rows created."""
    if not user_ids:
        return 0
    cur.execute(_ENSURE_PEOPLE_SQL, (list(user_ids),))
    return cur.rowcount


def load_index(cur) -> PeopleIndex:
    cur.execute(_INDEX_SQL)
    idx = PeopleIndex()
    name_count: dict[str, int] = {}
    names: dict[str, str] = {}
    for person_id, user_id, p_email, u_email, full_name in cur.fetchall():
        if user_id:
            idx.user_by_person[person_id] = user_id
        for email in (p_email, u_email):
            if email:
                idx.by_email.setdefault(norm(email), person_id)
        if full_name:
            key = norm(full_name)
            name_count[key] = name_count.get(key, 0) + 1
            names[key] = person_id
    # An ambiguous name must not silently pick one of several people.
    idx.by_name = {k: v for k, v in names.items() if name_count[k] == 1}
    return idx
