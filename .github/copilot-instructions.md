# Repository Copilot Instructions — clever-vpn-crm

## Git Workflow Policy (Mandatory)

Follow this policy for all changes unless the user explicitly overrides it in the current chat.

1. Never push directly to `main`.
2. Do all work in a non-main branch.
3. Use pull requests for all merges into `main`.
4. Preferred lifecycle is:
   - issue -> new branch -> implement -> PR -> merge -> delete branch
5. After PR merge, delete both remote and local feature branches when possible.

## Branching Rules

1. If current branch is `main`, create and switch to a new working branch before making commits.
2. Keep branch names task-oriented (`feat/<topic>`, `fix/<topic>`, `docs/<topic>`).

## PR Rules

1. CI (`validate`) must pass before merge.
2. PR titles and descriptions state the behavior change and why.

## Safety Rules

1. Do not use destructive git operations unless explicitly requested.
2. Do not rewrite shared history unless explicitly requested.
3. Never commit secrets, tenant API tokens, payment credentials, or real customer data.

## Local Git Hooks (Mandatory)

`.githooks/pre-push` blocks every push to `refs/heads/main`. It is the same script used in
`clever-vpn-cf-api`: identical content, no per-repo tuning.

Server-side protection is the real gate, but it is not always available (a fork does not inherit
it; a private repo on a free plan cannot create rulesets). The local hook is what makes the policy
hold on your machine.

Enable it once per clone — it is local git config, so it is **not** inherited by forks or clones:

```bash
git config core.hooksPath .githooks
```

Verify before assuming you are protected:

```bash
git config --local --get core.hooksPath   # → .githooks
```

When something is blocked, do **not** work around it (`--no-verify`, pushing to `main` from another
remote). Create a branch and open a PR.

## Default Execution Pattern

When the user asks for implementation work, default to this order:

1. Confirm/locate issue context.
2. Create a new branch (never work on `main`).
3. Implement and validate changes (`npm run check`: typecheck + tests).
4. Commit and push the branch.
5. Open a PR.
6. Merge the PR after `validate` is green.
7. Delete the feature branch locally and remotely.

## Release Tag Rules

1. Tags and GitHub Releases use a `v` prefix (`v1.2.3`).
2. A release must publish the deployable artifact (`crm-worker.mjs`) plus `wrangler.example.jsonc`
   and `checksums.txt`, so the hosted platform can run exactly the same bytes tenants self-host.

## Stack Conventions

This repository is an **open-source, self-hostable tenant CRM** on Cloudflare Workers.

- **Independence is a hard requirement**: this repo must never depend on cf-api internals or on
  `clever-vpn-crm-saas`. The only coupling to the platform is `docs/contract.md`
  (tenant API token + documented HTTP endpoints). cf-api must not know CRM exists.
- **One storage model**: one Worker + one D1 (`env.DB`). Do not add per-tenant routing here —
  multi-tenancy lives in `clever-vpn-crm-saas` (dispatch), never in this repo.
- **Migrations ship with the code** (`src/migrations.ts`, self-applied via schema fingerprint in
  `src/db.ts`). Rules: statements must be idempotent (`IF NOT EXISTS`), only backward-compatible
  changes (add table/column), never edit a published migration — add a new one.
- **No hosted-only code paths** (`if (hosted) …`). Differences between self-hosted and hosted must be
  expressed purely through bindings/vars (`CRM_TENANT_ID`, `CF_API_BASE`, `CF_API_TOKEN`).
- Secrets only via `wrangler secret put` (`CF_API_TOKEN`, `SESSION_SECRET`). Never read or log them.
- Payments stay out of scope: adapters call the tenant's own payment provider; the CRM records the
  resulting state. Never store card data.
- Keep `/health` and `/__version` stable — the hosted platform and uptime checks depend on them.
- Document behavior changes in `docs/` in the same PR; contract changes must bump
  `CRM_CONTRACT_VERSION` and stay additive.
- Node version follows `.nvmrc` (22); dependencies must run on default GitHub Actions runners.
- Before finishing any change, run `npm run check` (typecheck + unit tests) and `npm run build`
  (dry-run bundle) — CI runs the same commands, so a local pass means no surprise red PR.
