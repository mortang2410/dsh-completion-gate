# Security

Completion Gate is a local DSH host plugin. It is an advisory tracker: it records the model's claims about changed files, reviews, documentation, and verification items, and it never runs a project's verification.

## No verification execution

The gate executes no test, build, lint, typecheck, recipe, or temporary probe. It writes no test result, reads no verification output, and has no code path that runs a project command. A catalog item's `command` field is documentation for the next session; the gate never executes it.

Repository discovery reads the filesystem for the nearest `.git` entry and starts no process. The only process the gate may start is Git, for two jobs:

- reading a nested repository's HEAD;
- resolving the path of the repository's local exclude file before `.dsh/` is appended to it.

Those calls only read. The gate appends the exclude line itself with a file write, and nothing here verifies, builds, or tests.

## The catalog is knowledge

`.dsh/verification.json` inside each repository is operator-readable knowledge. The gate reads it, merges registered items into it, and never treats it as execution input. A catalog that cannot be read is reported and never overwritten.

The gate adds `.dsh/` to the repository's local exclude file, so the catalog is not committed. The tracked `.gitignore` is never edited.

## Credential scan

The added-line scan is kept. When `securityScan` is enabled, the gate reads the turn's added lines from the host change recorder and looks for a deliberately narrow set of high-confidence patterns, such as a likely hard-coded credential. The advisory names the rule and the number of matching lines, never the matched text. A changed file whose added lines cannot be read is named so the scan's gap is visible.

The scan is a regression tripwire, not a substitute for a dedicated secret scanner, dependency scanner, or human security review.

## Browser control center

The settings API accepts same-origin browser requests only. UI-saved settings are persisted host-side, and the persistence path itself is not returned to the browser.

The panel shows repository roots and changed file paths, because the model and the operator need them to act on the advice. It shows no command output, because the gate captures none.

## Settings integrity

Changing settings restarts the premature-stop bookkeeping only. Claims, item states, attestations, and the advisory's one-message-per-prompt bound are kept, so a settings change cannot speak twice for one prompt. The settings file uses schema version 2. A schema-1 file is ignored.
