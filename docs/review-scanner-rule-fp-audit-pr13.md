# PR-13 review scanner false-positive audit

Scope: `src/review/scanner.ts` deterministic `RULES` entries. This audit only changes `while-no-cursor`; the other items below are inventory for human prioritization.

## Decision

`while-no-cursor` now uses condition-variable extraction instead of a cursor keyword list. The scanner extracts each `while (...)` condition, masks strings/comments, identifies condition variables, then accepts the loop when those variables are assigned, incremented/decremented, compound-assigned, or consumed via iterator-style calls such as `shift`, `pop`, `splice`, or `next`.

Reason: the dogfood false positive was not missing a magic word; it had a real condition cursor (`i`) advanced by `i++` inside the loop. Checking whether the condition variables move is the smaller and more correct semantic test. True non-advancing loops, such as `while (x < 10) { y++; }`, still report.

## Rule Inventory

| Rule | Current matcher | False-positive surface | Action |
| --- | --- | --- | --- |
| `R6-as-any` | `as any` token | Intentional boundary casts, generated SDK compatibility shims, tests outside excluded patterns, migration adapters that isolate unsafe input. | Inventory only. |
| `R6-as-unknown-as` | `as unknown as` token | Legitimate branded-type or external-library bridge casts where runtime validation already happened. | Inventory only. |
| `debug-console-log` | `console.log(` with CLI stdout exception | Non-debug CLI output not named `markdown/report/output/result/stdout/json`, examples/docs inside source files, structured logging wrappers still using `console.log`. | Inventory only. |
| `debug-debugger` | `debugger` token | Documentation snippets or intentional local-only debug hooks in non-test source. | Inventory only. |
| `todo-fixme` | TODO/FIXME/HACK/XXX token | Accepted roadmap markers, third-party copied notices, changelog examples. It is INFO only. | Inventory only. |
| `window-document` | `window.*` / `document.*` in miniprogram mode | Guarded platform checks, adapter polyfills, SSR-safe `typeof window` probes, `.d.ts` excluded but not all generated type helpers. | Inventory only. |
| `hardcoded-credentials` | credential-ish words / bearer / `sk-...` | Config key names, redacted sample strings, documentation examples, test fixtures outside excluded test paths. | Inventory only. |
| `xss-innerHTML` | `innerHTML` / `dangerouslySetInnerHTML` | Sanitized HTML render paths, string literals documenting the API, framework wrappers with trusted content contracts. | Inventory only. |
| `code-injection` | `eval(` / `new Function(` | Sandboxed expression engines, parser tests outside excluded test paths, documentation snippets in source. | Inventory only. |
| `raw-collection` | `db.collection("literal")` in miniprogram mode | One-off migration/admin scripts, test fixtures not matching test filename conventions, generated service code before constants exist. | Inventory only. |
| `update-no-version` | `.doc(...).update(` plus nearby `version` heuristic | Version guard on a helper call or variable name outside the 5-line window; unrelated `version` nearby can also create false negatives. | Inventory only. |
| `while-no-cursor` | semantic condition-variable movement check | Still conservative for loops that terminate only through `break`, external mutation, awaited side effects, or helper calls that advance a cursor indirectly. | Fixed in PR-13. |
| `cloud-function-no-try` | `wx.cloud.callFunction` with previous-20-line `try` scan | Promise `.catch`, wrapper helpers, higher-order retry utilities, `try` beginning more than 20 lines above. | Inventory only. |
| `usedidshow-no-refetch` | `useDidShow` with 15-line refresh keyword scan | Refresh delegated to named helper without keywords, stores that auto-refresh, longer callbacks, UI-only callbacks not covered by current UI-only allowlist. | Inventory only. |

## Evidence Links

- Dogfood fixture copied into `__tests__/fixtures/dogfood-final-3-cli-git-weekly.ts`.
- Regression tests: `__tests__/review-scanner-while-cursor.test.ts`.
- Review-loop convergence test: `__tests__/review-loop-orchestrator.test.ts`.
