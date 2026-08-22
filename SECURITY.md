# Security

Completion Gate is designed as a local DSH host plugin.

## Browser control center

The settings API accepts same-origin browser requests only. UI-saved settings are persisted host-side and the persistence path itself is not returned to the browser.

Changing gate policy invalidates cached machine evidence, attestations, and operator overrides so a PASS generated under an older/weaker policy cannot survive silently.

## Custom checks

Custom checks are operator-defined shell commands executed inside the active project workspace. They are **not** accepted through the model-facing `completion_gate` attestation tool.

Treat custom checks exactly like commands placed in a CI configuration: only configure commands you trust.

## Reports and command output

- Browser/session reports expose the workspace basename rather than the absolute local path.
- Captured command output is sanitized before storage/rendering.
- Common bearer-token/credential patterns and absolute local filesystem paths are redacted.
- Output retention is bounded by `maxOutputChars`.

## Security scanner scope

The built-in added-code scanner is intentionally narrow and high-confidence. It is a regression tripwire, not a substitute for a dedicated SAST product, dependency scanner, secret scanner, or human security review.
