# YOLO Release Candidate Gate

`yolo release candidate` is the operator-facing entrypoint for release-candidate readiness. The next step for a release candidate is the generic RC gate, not Trello replay.

## Commands

```bash
yolo release candidate --mode rc --json
yolo release gate --mode publish --dry-run --json
```

Supported options:

- `--json`: emit structured machine-readable output.
- `--mode rc|publish`: select RC readiness or publish readiness. The default is `rc`.
- `--dry-run`: describe or run the gate without release mutations.
- `--allow-untracked`: explicitly allow untracked files when the injected gate runner supports that policy.
- `--allow-unknown`: explicitly allow unknown evidence states when the injected gate runner supports that policy.

The command is fail-closed by default. Its built-in lightweight runner creates local plan/provenance evidence, then blocks when real verify, PRD preflight, package smoke, clean-env, dogfood, or review evidence is missing. Runner exceptions are caught and returned as `status: "error"` JSON, so automation never has to parse a naked stack trace.

## Required Gates

Every release-candidate decision must account for these gates:

- `verify`: project verification must pass.
- `prd-preflight`: PRD dependency and contract preflight must pass.
- `package-smoke`: packed package and public CLI smoke must pass.
- `clean-env`: clean clone or clean environment execution must pass.
- `dogfood-matrix`: required dogfood matrix must pass with evidence.
- `change-provenance`: release-relevant changes and artifacts must have provenance.
- `review-findings`: release-relevant review findings must be resolved or explicitly blocked.

## Contract

The minimal JSON shape is:

```json
{
  "schema": "yolo.release_candidate_cli_result.v1",
  "status": "blocked",
  "mode": "rc",
  "fail_closed": true,
  "gate_kind": "generic_rc_gate",
  "not_trello_replay": true,
  "allowances": {
    "untracked": false,
    "unknown": false
  },
  "gates": [
    { "id": "verify", "required": true, "status": "pending" }
  ],
  "blockers": [],
  "next_actions": []
}
```

`status` may be `pass`, `blocked`, or `error`. Any missing, unknown, failed, or unparseable required gate blocks the release candidate.
