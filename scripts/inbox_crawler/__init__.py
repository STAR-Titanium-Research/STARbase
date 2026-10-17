"""The inbox crawler: finds new files in personal and team folders on the lab share.

Read-only against the share (ADR-0020): `fs_readonly` is the only module that touches it. Spec:
docs/superpowers/specs/2026-10-15-found-files-inbox-design.md. Run with `python -m inbox_crawler`.
"""
