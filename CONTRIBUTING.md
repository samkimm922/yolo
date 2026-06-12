# Contributing to YOLO

Thank you for your interest in improving YOLO. This project uses a pull-request workflow with mandatory automated checks.

## Development workflow

1. Fork the repository and create a feature branch from `main`.
2. Make focused, atomic commits. Each commit should pass `npm test` on its own.
3. Open a pull request against `main`.
4. Ensure **all** CI jobs pass before requesting review.
5. Merge only after at least one review approval and a green CI status.

## Required checks

Pull requests must pass the following CI jobs:

- `typecheck` — `npm run typecheck`
- `build` — `npm run build`
- `unit` — `npm test`
- `verify` — `npm run verify`
- `docs-warning-truth` — documentation and warning inventory sync tests
- `package-smoke` — install artifact smoke test
- `repo-hygiene` — no tracked `.yolo/` runtime artifacts, no dead vitest config
- `source-grep-meta` — source metadata and forbidden pattern checks
- `workflow-security-guards` — CI actionlint and security guard checks
- `clean-clone` — fresh clone (`git clone --no-hardlinks . /tmp/p5-clean && cd /tmp/p5-clean && pnpm install --frozen-lockfile && npm test`) must pass

> **Note:** Branch protection with required status checks will be enabled once the repository is made public. Until then, the checks above are enforced by convention and must be kept green on every pull request.

## Local verification

```bash
pnpm install --frozen-lockfile
npm run typecheck
npm test
npm run verify
```

To reproduce the CI clean-clone check locally:

```bash
rm -rf /tmp/p5-clean
git clone --no-hardlinks . /tmp/p5-clean
cd /tmp/p5-clean
pnpm install --frozen-lockfile
npm test
```

## Commit messages

Use conventional commits with a task reference when applicable:

```
fix(P5.C1): short description
```

## Code of conduct

Be respectful, provide evidence for claims, and prefer small, reviewable changes over large refactors.
