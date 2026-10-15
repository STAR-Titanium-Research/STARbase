"""What kind of file a name says it is, and the shape every classifier answers in."""

from __future__ import annotations

from dataclasses import dataclass, field

from . import fs_readonly

# Documents: listed by name, size and date only, never opened before a person links them.
DOCUMENT_EXTENSIONS = (
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".txt",
    ".ppt",
    ".pptx",
    ".odt",
    ".ods",
    ".rtf",
    ".md",
)


@dataclass(frozen=True)
class Classification:
    """kind is one of sem_image, surface_scan, image, document, other.

    confidence is NULL when no classifier looked at the file. `extracted` holds only values that were
    actually read from the file (metadata or, when switched on, the data bar's text), never guesses.
    `reason` is for the log, not the database.
    """

    kind: str
    confidence: float | None = None
    extracted: dict = field(default_factory=dict)
    reason: str = ""


def kind_by_name(name: str) -> Classification:
    """The kind a file name alone gives it. An image is just 'image' here: looking at the picture is
    classify_sem's job."""
    from . import (
        classify_scan,  # here, not at the top: classify_scan imports Classification
    )

    ext = fs_readonly.extension(name)
    scan = classify_scan.classify_scan(name)
    if scan is not None:
        return scan
    if ext in fs_readonly.IMAGE_EXTENSIONS:
        return Classification("image")
    if ext in DOCUMENT_EXTENSIONS:
        return Classification("document")
    return Classification("other")
