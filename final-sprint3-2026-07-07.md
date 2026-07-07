# YOLO dogfood final sprint 3 report - 2026-07-07

Status: not achieved. The sprint stopped on the same-cause fuse before round 6.

Branch: `fix/dogfood-final-sprint-3`
Start HEAD: `e9f75d4`
Current scope: YOLO runtime/reporting fixes plus focused tests.

## Outcome

The target was 3 consecutive zero-intervention ship rounds within 6 rounds. That was not reached.

- Round 1: not counted; code repairs required.
- Round 2: not counted; review/report false blocker required code repair.
- Round 3: not counted; product selfcheck failed on line stats, leading to synthetic acceptance strengthening.
- Round 4: not counted; `yolo run` ended nonzero even though retry later passed, because run report counted recovered remediation as active. Fixed in `src/runtime/evidence/report.ts`.
- Round 5: `yolo run` and explicit `yolo ship` both succeeded, but product selfcheck item 3 failed because stdout had one extra trailing newline versus `--output` file content.
- Round 6: not run. Round 5 exposed the same class as Round 3: generated acceptance was still not strong enough to require stdout and `--output` content equivalence. Per same-cause second-repair fuse, I stopped instead of making another acceptance-generation patch.

## Repairs Landed

1. Automated acceptance/test task timeout floor:
   `computeTaskTimeout` now accepts `task` and gives test/acceptance generation tasks a floor at least the executor default `600000ms`; other task kinds are unchanged.

2. Acceptance recovered remediation:
   acceptance reporting ignores recovered auto-remediation when automation can continue and no human/unsafe stop remains.

3. Terminal PRD task evidence:
   terminal PRD task state writes now add task result JSONL evidence when no stronger evidence reference exists.

4. Review/report false blocker:
   CLI usage `console.log` is not treated as debug logging, and clean review reports only block HIGH/CRITICAL or must-fix findings.

5. Synthetic acceptance strength:
   git-weekly shaped demands now carry concrete proof markers for authors, fixed dates, total commits, and nonzero added/deleted line assertions.

6. Run report recovered remediation:
   run reports now distinguish active remediation from remediation recovered by latest persisted task-results PASS/merged state. Recovered history remains visible, but no longer counts as active human/unsafe blockers.

## Verification

- `npm test --silent`: PASS, `2058/2058`, duration `208201.900775ms`.
- `npm run typecheck --silent`: PASS; strict errors stayed at `1247`, strict+noImplicitAny at `1900`.
- `git diff --check`: PASS.
- `node --import tsx --test __tests__/warning-inventory.test.ts`: PASS.
- Focused tests passed:
  - `__tests__/runner-core-helpers.test.ts`
  - `__tests__/session-attempt.test.ts`
  - `__tests__/acceptance-report.test.ts`
  - `__tests__/runner-task-state-writers.test.ts`
  - `__tests__/sdk.test.ts`
  - `__tests__/evidence-report.test.ts`
  - `__tests__/demand-runtime.test.ts`
  - `__tests__/run-lifecycle-finalize.test.ts`

## Provider Timeout Discipline

- Round 4 had one provider timeout on `DEMAND-REQ-002-0020101`: `192552ms`, then retry passed. This was recorded as provider jitter, not a code repair trigger.
- Round 5 had no same-task repeated timeout pattern. `DEMAND-REQ-002-0020101` completed in `183s`.
- No task hit the same fixed-period timeout 3 times.

## Round 5 Ship JSON

Raw file: `/Users/sippingroom/Developer/dogfood-sprint3-5-evidence/yolo-ship.stdout`

```json
{
  "status": "success",
  "summary": "Ship gate passed; delivery is ready.",
  "ship": {
    "status": "success",
    "code": "SHIP_READY",
    "summary": "Ship gate passed; delivery is ready.",
    "blockers": [],
    "artifacts": [
      "/Users/sippingroom/Developer/dogfood-sprint3-5/.yolo/lifecycle/acceptance-report.json",
      "/Users/sippingroom/Developer/dogfood-sprint3-5/.yolo/lifecycle/delivery-report.json"
    ]
  }
}
```

## Round 5 Product Selfcheck

Raw file: `/Users/sippingroom/Developer/dogfood-sprint3-5-evidence/product-selfcheck.txt`

```text
1. npm test — PASS (exit=0)
2. stdout markdown includes required weekly report facts — PASS (exit=0)
3. --output writes the same report file — FAIL (exit=0)
4. bad --repo exits nonzero — PASS (exit=1)
```

Failure detail: `selfcheck-stdout.md` and `selfcheck-weekly.md` differed only by one trailing newline. This is small product behavior drift, but it means the automated acceptance did not encode the stricter stdout/file equivalence check.

## Evidence Paths

- Round 3 evidence: `/Users/sippingroom/Developer/dogfood-sprint3-3-evidence`
- Round 4 evidence: `/Users/sippingroom/Developer/dogfood-sprint3-4-evidence`
- Round 5 evidence: `/Users/sippingroom/Developer/dogfood-sprint3-5-evidence`

## Next Decision

To continue beyond the fuse, the next scoped fix should harden synthetic acceptance for stdout/`--output` equivalence and prevent generated CLIs from adding stdout-only trailing content. That should be a deliberate new round, not silently folded into this sprint.
