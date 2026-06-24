# Contributing to jack

Thanks for your interest in improving jack! Contributions of all kinds are
welcome — bug reports, fixes, features, docs, and ideas.

By participating in this project, you agree to abide by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Getting set up

jack is a [Bun](https://bun.com) workspace, and tooling is managed with
[mise](https://mise.jdx.dev). The fastest path:

```sh
# Installs the pinned Bun version and other tools
mise install

# Install workspace dependencies
bun install

# Generate the OpenAPI-derived schema clients (gitignored — needed before tests)
mise run clients:generate
```

## Development

Common tasks (run `mise tasks` to see them all):

| Task | What it does |
| --- | --- |
| `mise run dev` | Backend dev server with hot reload |
| `mise run ui` | Management UI dev server (Nuxt) |
| `mise run lint` | Lint the workspace |
| `mise run lint:fix` | Lint and auto-fix |
| `mise run test` | Unit tests (`bun test`) |
| `mise run test:e2e` | End-to-end tests against real containers |
| `mise run test:full` | Both suites |

## Before you open a PR

1. **Lint is the source of truth.** Run `mise run lint:fix` and commit what it
   produces — please don't hand-tweak style to something else.
2. **Tests pass.** Run `mise run test` (and `mise run test:e2e` if your change
   touches the request/transfer paths).
3. **Conventional Commits.** Commit messages follow
   [Conventional Commits](https://www.conventionalcommits.org), e.g.
   `feat: add peer search spans` or `fix: handle missing torrent files`. The
   changelog is generated from these, so the prefix matters.
4. **Signed commits.** All commits must be signed — GitHub enforces this and
   will reject unsigned commits. If you haven't set up commit signing yet, see
   [Signing commits](https://docs.github.com/authentication/managing-commit-signature-verification/signing-commits)
   (GPG, SSH, and S/MIME all work; `git commit -S`, or `git config commit.gpgsign true`
   to sign automatically).

## Pull requests

- Branch off `main` and keep PRs focused — one logical change per PR is easier
  to review.
- Describe what changed and why. Link any related issue.
- CI runs lint, unit tests, and e2e on every PR; please make sure it's green.

## Reporting bugs and security issues

- For ordinary bugs, open an issue using the templates.
- For **security vulnerabilities**, do not open a public issue — follow the
  [Security Policy](./SECURITY.md) and report privately via GitHub Security
  Advisories.

Happy hacking! 🛠️
