---
name: release-notes
description: Create structured release notes from changes.json when the user asks for release notes, RELEASE_NOTES.md, a changelog, or a release summary.
metadata:
  owner: keel
---

# Release notes workflow

1. Read the requested changes data before writing.
2. Exclude entries that are not user-facing.
3. Map breaking, feature, and fix kinds to the requested headings.
4. Sort entries numerically within each group.
5. Write only the requested release-notes file, then read it back to verify grouping and formatting.
