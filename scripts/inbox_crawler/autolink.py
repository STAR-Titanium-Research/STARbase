"""Ask the d1-inbox extension to auto-link files (spec section 5). The crawler never links itself.

After a scan, files of opted-in people that name exactly one record by an exact short ID (images and
surface scans, never documents, never copies) are offered to `POST /d1-inbox/auto-link` with the shared
secret in `X-Inbox-Crawler-Secret`. The extension decides: it re-checks the opt-in, the match and that the
person can edit the record, links as that person and answers per candidate. This module only asks, and
remembers which candidates got a definite answer so they are not asked again by this process.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request

log = logging.getLogger("inbox_crawler.autolink")

PATH = "/d1-inbox/auto-link"
BATCH = 20
# A candidate the extension has answered for (linked, or skipped: not editable, opted out ...) is not
# offered again by this process for this long, then it is: the person may have got edit rights since.
ATTEMPT_TTL_S = 3600


class AutoLinkUnavailable(Exception):  # noqa: N818
    """The extension could not be reached or failed (connection, 5xx): try again after the next scan."""


class AutoLinkRefused(Exception):  # noqa: N818
    """The extension refused the crawler (wrong or missing secret): asking again will not help."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: the secret must go to the configured URL and nowhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # the 3xx then surfaces as an HTTPError


class AutoLinker:
    def __init__(self, base_url: str, secret: str, *, timeout: float = 30.0):
        self.url = base_url.rstrip("/") + PATH
        if not self.url.startswith(("http://", "https://")):
            raise ValueError("D1_INBOX_URL must be an http(s) URL")
        self._secret = secret
        self.timeout = timeout
        # No proxy from the environment (the secret must not go through one), no redirects.
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect
        )

    @property
    def enabled(self) -> bool:
        return bool(self._secret)

    def offer(self, candidate_ids: list[str]) -> list[dict]:
        """One request for up to BATCH candidates; the per-candidate results of the extension
        ({candidate_id, status: linked|skipped|error, reason?, link_batch_id?})."""
        body = json.dumps({"candidate_ids": candidate_ids}).encode()
        req = urllib.request.Request(
            self.url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Inbox-Crawler-Secret": self._secret,
            },
        )
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise AutoLinkRefused(
                    f"the extension answered HTTP {exc.code}"
                ) from None
            raise AutoLinkUnavailable(
                f"the extension answered HTTP {exc.code}"
            ) from None
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise AutoLinkUnavailable(type(exc).__name__) from None
        results = (payload.get("data") or {}).get("results")
        if not isinstance(results, list):
            raise AutoLinkUnavailable("an answer the crawler does not understand")
        return [r for r in results if isinstance(r, dict)]


def run_auto_link(
    store, linker: AutoLinker | None, attempted: dict, now=time.time
) -> dict:
    """Offer the eligible candidates to the extension. `attempted` maps candidates that already got a
    definite answer (linked or skipped) from this process to when; they are not offered again for
    ATTEMPT_TTL_S. An 'error' or an unreachable extension leaves them out so the next scan tries again.
    Returns counts for the log."""
    out = {"offered": 0, "linked": 0, "skipped": 0, "errors": 0}
    t = now()
    for cid in [c for c, at in attempted.items() if t - at >= ATTEMPT_TTL_S]:
        del attempted[cid]
    if linker is None or not linker.enabled:
        return out
    people = store.autolink_person_ids()
    todo = [
        c["candidate_id"]
        for c in store.autolink_candidates(people)
        if c["candidate_id"] not in attempted
    ]
    for i in range(0, len(todo), BATCH):
        chunk = todo[i : i + BATCH]
        try:
            results = linker.offer(chunk)
        except AutoLinkRefused as exc:
            log.error(
                "auto-link refused (%s): check D1_INBOX_CRAWLER_SECRET; not asking again this scan",
                exc,
            )
            break
        except AutoLinkUnavailable as exc:
            log.warning(
                "auto-link unavailable (%s); will try again after the next scan", exc
            )
            break
        out["offered"] += len(chunk)
        for r in results:
            cid, status = r.get("candidate_id"), r.get("status")
            if status in ("linked", "skipped") and cid in chunk:
                attempted[cid] = t
            if status == "linked":
                out["linked"] += 1
            elif status == "skipped":
                out["skipped"] += 1
            else:
                out["errors"] += 1
    return out
