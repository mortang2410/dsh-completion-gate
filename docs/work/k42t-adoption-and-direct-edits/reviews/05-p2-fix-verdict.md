# Independent review verdict: 5d82b45c61d08d2ac54f743fb1926e267667200f

## Scope

The review covers commit `5d82b45c61d08d2ac54f743fb1926e267667200f`, parent `80269571b4627b2ab4439f3cf9ec8c4dfded844a`. The shared branch advanced to `01e49af` while this review ran. The later commits changed only files under `docs/work/`; the three files changed by the target commit have identical Git blob hashes (content identifiers) at the target and current `HEAD`:

- `README.md`: `0faa120902b802a2e73ae5e3f88d575ced5c17c5`
- `lib/changes.js`: `8597768afd28865f002a6a8be3992030f890260f`
- `tests/gate-changes.test.mjs`: `f0cf8eda3eab5bc5e4fa11e6925d9cbd93424ccd`

The review did not open or change any `docs/work/` file. The review also left the three target files clean in the shared checkout.

## Verification

### Before: restored parent implementation

- `git -C /home/wilder/dsh-test/dsh-completion-gate archive --format=tar 5d82b45c61d08d2ac54f743fb1926e267667200f package.json lib tests | tar -x -C /home/wilder/Trash/k42t-p2-fix --one-top-level=review-red-state`: exit 0. The archive contained 23 files and 471,040 bytes. The archive omitted `docs/work/`.
- `git -C /home/wilder/dsh-test/dsh-completion-gate show 80269571b4627b2ab4439f3cf9ec8c4dfded844a:lib/changes.js > /home/wilder/Trash/k42t-p2-fix/review-red-state/lib/changes.js`: exit 0. Readback confirmed the parent code resolved `path.resolve(String(base), file)` before canonicalization.
- `cd /home/wilder/Trash/k42t-p2-fix/review-red-state && timeout --kill-after=5s 120s node --test --test-name-pattern='a session whose cwd contains symlink/\.\.' tests/gate-changes.test.mjs`: exit 1; 1 test, 0 passed, 1 failed. The new test failed at its expected tracking assertion: actual repositories were `[]`, while the expected result contained `/home/wilder/Trash/3t34-tests/cg-gate-7fYcrY/target/app.js`. The test raised `ERR_ASSERTION` from the product report assertion, not a setup or incidental error.

### After: target implementation

- `cd /home/wilder/dsh-test/dsh-completion-gate && timeout --kill-after=5s 120s npm run check`: exit 0.
- `cd /home/wilder/dsh-test/dsh-completion-gate && timeout --kill-after=5s 300s npm test`: exit 0; 292 tests, 292 passed, 0 failed. The run passed the prior symlinked-working-directory test (`ok 46`), the new `symlink/..` service regression (`ok 47`), and the prior symlinked-ancestor/missing-leaf tracker test (`ok 268`).
- The target’s source and test blobs still matched the current checkout after the later `docs/work/` commits, so those checks exercised the reviewed code and tests.

### Required static scan

- `cd /home/wilder/dsh-test/dsh-completion-gate && cccc lib/changes.js tests/gate-changes.test.mjs`: exit 0; 2 files, 83 functions, 0 parse errors; cognitive complexity sum 108 and maximum 23; cyclomatic complexity sum 206 and maximum 23.
- `cd /home/wilder/dsh-test/dsh-completion-gate && timeout --kill-after=5s 60s lizard -l javascript lib/changes.js tests/gate-changes.test.mjs`: exit 1 because lizard reports two threshold warnings; 2 files, 783 non-comment source lines (NLOC), 79 functions, 2 warnings. Lizard reports `contentKey` at cyclomatic complexity number (CCN) 16 and 29 NLOC, and `observe` at CCN 16 and 16 NLOC in `lib/changes.js`.
- `timeout --kill-after=5s 60s lizard -l javascript /home/wilder/Trash/k42t-p2-fix/review-red-state/lib/changes.js`: exit 1; the parent file has the same `contentKey` and `observe` warnings, with the same CCN and NLOC. I restored that file from `git show 8026957:lib/changes.js` before the scan. Both lizard warnings predate this commit.

### Path behavior probes

- `node --input-type=module -e 'import path from "node:path"; import { realpath } from "node:fs/promises"; const raw="../Trash/3t34-tests/cg-gate-7fYcrY/link/.."; const file="app.js"; const old=path.resolve(raw,file); const newBase=path.resolve(raw); const newPath=path.resolve(newBase,file); const host=path.resolve(await realpath(raw),file); console.log(JSON.stringify({raw,oldParentPath:old,newBase,newPath,hostPath:host},null,2))'`: exit 0. Both the parent formula and the new relative-base branch resolve to `/home/wilder/Trash/3t34-tests/cg-gate-7fYcrY/app.js`; the Host’s realpath-first result is `/home/wilder/Trash/3t34-tests/cg-gate-7fYcrY/target/app.js`.
- `node --input-type=module -e 'import path from "node:path"; console.log(path.resolve("/canonical/base","/outside/file.js"))'`: exit 0; output `/outside/file.js`. An absolute file-tool path is not joined under the canonical base.

## Axis A: correctness and standards

**The resolve order matches the DSH Host, the runtime that records workspace changes, for valid sessions.** The Host obtains `cwd` from `session.header.cwd` without rewriting it (`packages/deliverables/workspace-changes/src/index.ts:58-60,130-147`). The session store copies supplied `meta.cwd` into the header and validates it as absolute before publication (`packages/core/session/src/index.ts:97-120,1049-1060`). The recorder realpaths that raw cwd before a turn baseline (`packages/deliverables/workspace-changes/src/recorder.ts:131-147`), resolves each file-tool path against the canonical cwd before canonicalizing the file (`packages/deliverables/workspace-changes/src/recorder.ts:156-166`), and returns the raw cwd in the summary (`packages/deliverables/workspace-changes/src/recorder.ts:354-365`). It stores inside-workspace file paths relative to the canonical cwd (`packages/deliverables/workspace-changes/src/recorder.ts:395-403`; `packages/deliverables/workspace-changes/src/paths.ts:91-98`). The Host helper realpaths an existing path and appends a missing suffix (`packages/deliverables/workspace-changes/src/paths.ts:49-63`).

The gate passes `record.base || fallback` to `fileToolPaths` (`lib/index.js:480-519`). The tracker independently canonicalizes the same record base with `realPathOf` before resolving the recorder’s durable path (`lib/tracker.js:42-55`). The change now canonicalizes the tool-path base before resolving each tool path (`lib/changes.js:199-205`), so the two absolute paths meet even when an absolute cwd contains a symlink followed by `..`.

The relative-base caveat is real but not introduced here. A direct caller that supplies a relative base containing `symlink/..` still gets lexical collapse before realpath, as the probe shows. The parent formula had the same result. The live Host cannot supply that input because the session store rejects a relative cwd; therefore this is not a supported-runtime finding. When the summary base is absent, `lib/index.js:518` uses the required session cwd fallback, and `repositoryReport` refuses a missing cwd (`lib/index.js:480-484`).

The implementation adds one base canonicalization per `fileToolPaths` call, before the per-path loop (`lib/changes.js:202-205`). It does not canonicalize the base once per file. Absolute tool paths remain absolute, as the direct probe confirmed. The change reuses the existing `canonicalPath` helper and adds no import of `lib/repositories.js`; the change module imports only Node built-ins (`lib/changes.js:1-5`). The comment describes the implemented order.

The regression test exercises the real `CompletionGateService`, `ChangeTracker`, and repository report path (`tests/gate-changes.test.mjs:7,48-65,236-256`). The test injects a fake Host `workspaceChanges` summary, but it does not reimplement the path-resolution algorithm. The Host source independently confirms that the fake summary’s raw cwd and relative durable path match the actual Host contract. The red-state run failed at the missing-tracking assertion, and the full suite passed it after the fix. The test is a plugin integration test at the Host service boundary, not a full Host-plus-plugin runtime test.

## Axis B: specification and documentation fidelity

`README.md:137` now describes the advisory’s actual order: it lists stated items, then prints the `Unstated catalog items` count when that count is nonzero, and omits the count line at zero. `lib/report.js:109-116` emits only the stated items, then conditionally emits the summary line, then emits attestation and next-action lines. The advisory path does not call `catalogLines`, so it does not include the full catalog list.

For a readable catalog, the status report includes its full reading list. `lib/report.js:11-19` emits the summary before `catalogLines` and then prints file and item states; `lib/report.js:53-63` renders all catalog items. When the catalog is absent or unreadable, `catalogLines` emits a corresponding notice instead of a list. The neighboring README description at lines 190-205 says the status report carries catalog items and states, so the advisory sentence does not contradict it. At zero unstated items, `lib/report.js:115` omits the count because it emits only when `unstatedCount > 0`.

The other changed README statements match the current behavior. The allowed mutating tool names and argument predicates match the Host’s `mutationPath` (`packages/deliverables/workspace-changes/src/capture.ts:99-111` and `lib/changes.js:114-124`). The item-state text matches the system prompt and tracker: the prompt no longer asks the model to mark items unrelated (`lib/index.js:677-680`), and absent item states count as history rather than obligations (`lib/tracker.js:363-388`).

## Findings

None.

## Verdict

ACCEPT (no P1/P2 findings)
