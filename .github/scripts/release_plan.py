#!/usr/bin/env python3
"""Decide what a force-app-release.yml run does, check the release is consistent, and write the
release notes. Runs in the workflow's first job; no build happens unless this says so.

What ships is always apps/force-app/desktop/package.json's version, as tag force-app-v<version>.
A version is "released" once a GitHub Release exists for that tag (d1-server's auto-publish task
polls Releases, not tags). So:

  push to main          release the version if it has no GitHub Release yet, else do nothing.
                        Merging a version bump ships it; a failed release is retried by the
                        next push to main, or by the button.
  workflow_dispatch     the button. Releases main's version if it has no Release; dry_run builds
                        and tests without publishing (any branch).
  pull_request          a dry run (build + every test, never publish) on PRs that change the
                        version or the packaging. Fails early if the version would ship without
                        its changelog entry.
  push of a tag         a hand-pushed force-app-v* tag, as before. It must match package.json.

Usage (CI): release_plan.py --notes <path>    env: EVENT, REF, SHA, DRY_RUN, REPO, GH_TOKEN
Locally:    EVENT=workflow_dispatch REF=refs/heads/main python3 .github/scripts/release_plan.py
"""

import argparse
import json
import os
import re
import subprocess
import sys

DESKTOP_PKG = "apps/force-app/desktop/package.json"
LOCKFILE = "package-lock.json"
CHANGELOG = "apps/force-app/web/src/changelog.ts"
BUMP_HINT = (
    'Bump the version and add its changelog entry first: ask Claude to "release the force app" '
    "(the force-app-release skill), merge that PR, and the release ships on its own."
)


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def sh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True)


def changelog_entry(text: str, version: str) -> tuple[str, list[str]] | None:
    """The (date, notes) of `version`'s entry in changelog.ts, or None. Reads the file as text:
    this job never runs repository code."""
    m = re.search(
        rf"version:\s*'{re.escape(version)}'(.*?)(?=version:\s*'|\Z)", text, re.S
    )
    if not m:
        return None
    body = m.group(1)
    date = re.search(r"date:\s*'([^']*)'", body)
    notes_block = re.search(r"notes:\s*\[(.*?)\]\s*,?\s*\}", body, re.S)
    notes = []
    if notes_block:
        for single, double in re.findall(
            r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"", notes_block.group(1)
        ):
            s = single or double
            notes.append(re.sub(r"\\(.)", r"\1", s))
    return (date.group(1) if date else ""), notes


# Release notes by category (#137). Same rules as apps/force-app/web/src/changelogGroups.ts, which
# groups the in-app "What's new" list: a note's leading prefix picks the group.
#   Fixed: / Security:  -> Fixed (Security keeps its prefix)    Improved:  -> Improved
#   New: or no prefix   -> New
NOTE_PREFIXES = {
    "New": ("New", True),
    "Improved": ("Improved", True),
    "Fixed": ("Fixed", True),
    "Security": ("Fixed", False),
}
NOTE_GROUPS = ("New", "Improved", "Fixed")


def group_notes(notes: list[str]) -> dict[str, list[str]]:
    """The notes split into New / Improved / Fixed, in that order, empty groups left out."""
    groups: dict[str, list[str]] = {g: [] for g in NOTE_GROUPS}
    for n in notes:
        group, text = "New", n
        m = re.match(r"([A-Za-z]+):\s+", n)
        if m and m.group(1) in NOTE_PREFIXES:
            group, strip = NOTE_PREFIXES[m.group(1)]
            text = n[m.end() :] if strip else n
        groups[group].append(text)
    return {g: v for g, v in groups.items() if v}


def render_notes(notes: list[str]) -> list[str]:
    """Markdown lines for the release body: a ### heading per non-empty group, then its bullets."""
    lines: list[str] = []
    for group, items in group_notes(notes).items():
        if lines:
            lines.append("")
        lines.append(f"### {group}")
        lines.append("")
        lines += [f"- {n}" for n in items]
    return lines


def top_changelog_version(text: str) -> str | None:
    m = re.search(r"version:\s*'([^']+)'", text)
    return m.group(1) if m else None


def release_exists(repo: str, tag: str) -> bool:
    r = sh("gh", "release", "view", tag, "--repo", repo, "--json", "tagName")
    if r.returncode == 0:
        return True
    if "release not found" in (r.stderr + r.stdout).lower():
        return False
    fail(f"Could not ask GitHub whether {tag} is released: {r.stderr.strip()}")
    return False  # unreachable


def remote_tag_sha(repo: str, tag: str) -> str | None:
    """The commit `tag` points at on GitHub, or None. The API, not `git ls-remote`: the workflow's
    checkout keeps no credentials, and this repository is private."""
    if repo:
        r = sh("gh", "api", f"repos/{repo}/commits/refs/tags/{tag}", "--jq", ".sha")
        return (r.stdout.strip() or None) if r.returncode == 0 else None
    r = sh(
        "git",
        "ls-remote",
        "--tags",
        "origin",
        f"refs/tags/{tag}",
        f"refs/tags/{tag}^{{}}",
    )
    lines = [ln.split("\t") for ln in r.stdout.strip().splitlines() if ln]
    if not lines:
        return None
    peeled = [sha for sha, ref in lines if ref.endswith("^{}")]
    return peeled[0] if peeled else lines[0][0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--notes", help="write the release notes (Markdown) here")
    args = ap.parse_args()

    event = os.environ.get("EVENT", "workflow_dispatch")
    ref = os.environ.get("REF", "refs/heads/main")
    sha = os.environ.get("SHA") or sh("git", "rev-parse", "HEAD").stdout.strip()
    dry_run = os.environ.get("DRY_RUN", "false") == "true"
    repo = os.environ.get("REPO", "")

    version = json.load(open(DESKTOP_PKG))["version"]
    tag = f"force-app-v{version}"
    lock = json.load(open(LOCKFILE))["packages"]["apps/force-app/desktop"]["version"]
    changelog = open(CHANGELOG, encoding="utf-8").read()
    released = release_exists(repo, tag) if repo else False

    # build: run the Windows build and every test. publish: create the GitHub Release.
    if event == "pull_request":
        build, publish = True, False
        reason = f"dry run for a PR (main would {'not ' if released else ''}release {tag} on merge)"
    elif event == "push" and ref.startswith("refs/tags/"):
        pushed = ref.removeprefix("refs/tags/")
        if pushed != tag:
            fail(
                f"Tag {pushed} does not match {DESKTOP_PKG} version {version} (expected {tag})."
            )
        if released:
            fail(f"{tag} already has a GitHub Release. {BUMP_HINT}")
        build, publish, reason = True, True, f"tag {tag} pushed by hand"
    elif event == "push":
        if released:
            build, publish, reason = (
                False,
                False,
                f"{tag} is already released; nothing to do",
            )
        else:
            build, publish, reason = (
                True,
                True,
                f"{tag} is on main and not released yet",
            )
    elif event == "workflow_dispatch":
        if dry_run:
            build, publish, reason = True, False, f"dry run of {tag} requested"
        else:
            if ref != "refs/heads/main":
                fail(
                    f"Releases are only cut from main (this run is on {ref}). Tick dry run to "
                    "build and test another branch."
                )
            if released:
                fail(f"{tag} is already released. {BUMP_HINT}")
            build, publish, reason = True, True, f"release of {tag} requested"
    else:
        fail(f"Unexpected event {event}")

    # Consistency checks. A version about to ship (or that would ship when the PR merges) must
    # have its lockfile entry and its changelog entry; a version that is already out needs neither.
    problems = []
    if lock != version:
        problems.append(
            f"{LOCKFILE} has desktop version {lock}, not {version}: run "
            "`npm install --package-lock-only`."
        )
    if not released:
        top = top_changelog_version(changelog)
        if top != version:
            problems.append(
                f"The top entry of {CHANGELOG} is {top}, not {version}: operators "
                "read it in Settings > About > What's new."
            )
    if problems:
        for p in problems:
            print(f"::error::{p}")
        sys.exit(1)

    tag_sha = remote_tag_sha(repo, tag)
    if publish and tag_sha and tag_sha != sha and not ref.startswith("refs/tags/"):
        # A tag with no Release is left over from a release build that failed (0.1.34 was).
        # Nothing ever shipped from it, so the publish job moves it to the commit being released.
        print(
            f"::notice::{tag} exists at {tag_sha[:7]} with no Release; the publish job will "
            f"move it to {sha[:7]}."
        )
    if ref.startswith("refs/tags/"):
        sha = tag_sha or sha

    entry = changelog_entry(changelog, version)
    if args.notes:
        lines = [
            f"Force App {version}" + (f" ({entry[0]})" if entry and entry[0] else ""),
            "",
        ]
        lines += (
            render_notes(entry[1]) if entry and entry[1] else ["- Maintenance release."]
        )
        lines += [
            "",
            "Rigs pick this up from the d1-server update feed within about ten minutes.",
        ]
        with open(args.notes, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    outputs = {
        "version": version,
        "tag": tag,
        "sha": sha,
        "build": str(build).lower(),
        "publish": str(publish).lower(),
        "reason": reason,
    }
    for k, v in outputs.items():
        print(f"{k}: {v}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.writelines(f"{k}={v}\n" for k, v in outputs.items())
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(
                f"### Force app {version}\n\n{reason}.\n\n"
                f"- Build and test: **{'yes' if build else 'no'}**\n"
                f"- Publish the GitHub Release: **{'yes' if publish else 'no'}**\n"
            )


if __name__ == "__main__":
    main()
