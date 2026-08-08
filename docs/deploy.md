# Deploying the Builder

`builder.nimbusapi.net` is an Azure Container App (`bolt-diy-nimbus`, RG
`nimbus-ai-swedencentral`), image from ACR `nimbusacr4768`. It is **not** on
Cloudflare Pages — `wrangler.toml` is inherited from upstream bolt.diy and is
not used to deploy.

Written after seven rollouts on 2026-08-07, each of which hit at least one of
the traps below.

## The procedure

```bash
# 1. Clean build context. NOT the working tree.
git worktree add --detach /tmp/ctx <branch>
cd /tmp/ctx

# 2. Build. --no-logs is not optional; see "cp932" below.
az acr build --registry nimbusacr4768 \
  --image bolt-diy-nimbus:<tag> --file Dockerfile --no-logs .

# 3. New revision at 0% traffic. This app is in Multiple revision mode,
#    so `update` does NOT shift traffic by itself.
az containerapp update -n bolt-diy-nimbus -g nimbus-ai-swedencentral \
  --image nimbusacr4768.azurecr.io/bolt-diy-nimbus:<tag> \
  --revision-suffix <tag>

# 4. Probe the revision's OWN fqdn, both directions, before shifting:
#    az containerapp revision show ... --query properties.fqdn

# 5. Shift.
az containerapp ingress traffic set -n bolt-diy-nimbus -g nimbus-ai-swedencentral \
  --revision-weight bolt-diy-nimbus--<new>=100 bolt-diy-nimbus--<old>=0
```

Rollback is step 5 with the weights reversed. The previous revision stays at
0% and is still warm.

## Traps, each of which cost real time

**`az acr build` exits 1 on success.** `UnicodeEncodeError: 'cp932' codec can't
encode character '✓'` — colorama writing the success checkmark through the
Win32 console API. `PYTHONIOENCODING`, `PYTHONUTF8`, `chcp 65001` and
PowerShell's `[Console]::OutputEncoding` all fail to stop it, because it does
not go through Python's stdout encoding. **`--no-logs` is the fix**: no log
streaming, so the checkmark is never printed. Without it the build can complete
server-side while the CLI dies before reporting the push, which reads as a
failed build that actually succeeded.

*Disagreement worth recording rather than smoothing over:* another session
reports `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` DO stop the crash. Those
were measured failing here. Conditions differ (shell, console host, az
version), and `--no-logs` sidesteps the question entirely, so it stays the
recommendation. If you have five spare minutes, settle it and delete whichever
half of this paragraph is wrong.

**Neither the exit code nor the console tells you a build finished.** The
encoding crash is the loud failure; the quiet one is worse — `az acr build` can
return **exit 0 while the build is still running**, so a green CLI proves
nothing about whether an image was produced. Reported by another session and
the remedy verified here: `az acr task list-runs` distinguishes them, because a
run in flight has a status and no finish time.

```bash
az acr task list-runs --registry nimbusacr4768 --top 5 \
  --query "[].{run:runId,status:status,tag:outputImages[0].tag,finished:finishTime}" -o table
```

```
dt14r  Running                                          <- no finish time
dt14q  Succeeded  2026-08-08T13:15:22+00:00
```

Treat that as the authority. `--no-logs` makes the CLI quiet by design, which
means it removes the only signal you had left — so pairing the two is the point,
not an extra step.

**Build from a worktree, never the working tree.** `az acr build` walks
`node_modules` while packing despite `.dockerignore`, and pnpm's symlink farm
makes it fail with `[WinError 2] ... LICENSE`.

**Do not symlink `node_modules` into that worktree.** `git worktree remove
--force` follows the symlink and deletes the real store. `rm -f` does not
defuse it either — it silently no-ops on a Windows junction. This destroyed
`node_modules` twice in one day. Recovery is `pnpm install --force`; a plain
`pnpm install` exits 0 and does nothing, because the state file still claims
everything is present.

**Verify at the revision FQDN, not the public domain**, until traffic is
shifted. The public domain still serves the old revision, so a green check
there proves nothing about what you just built.

**Probe both directions.** Anonymous requests must be denied *and* an
authenticated session must still work. A change that 401s everyone passes an
"is it secure" check perfectly.

## Verification

Before shifting traffic, against the revision's own FQDN:

```
anonymous  /api/*        -> 401   (except /api/health)
anonymous  /api/health   -> 200
anonymous  /             -> 302   (SSO redirect)
session    /api/models   -> 200   with providers + models
```

A session cookie can be minted for testing from the shared secret in
`az containerapp secret show -n bolt-diy-nimbus -g nimbus-ai-swedencentral
--secret-name nimbus-sso-secret`, signed HS256.

Note that `wrangler pages dev` is the only local way to exercise the auth
boundary: nine routes once destructured `{ request }` only, passing `context`
as `undefined`, so `requireBuilderAuth` saw an empty env, concluded it was not
production, and allowed everything. Tests, typecheck and build were all green.

## CI

`.github/workflows/ci.yaml` runs typecheck, lint and tests on push and PR.
It had **never executed** before 2026-08-08: this repo is a fork of
`stackblitz-labs/bolt.diy`, and GitHub does not run workflows on a fork until
the owner enables them once in the Actions tab. `GET /actions/permissions`
reports `enabled: true` regardless, so that endpoint is not a usable signal —
check `total_count` on `/actions/runs` instead.

`pnpm run typecheck` was red for months with 7 pre-existing errors, which is
why enabling CI earlier would only have produced a gate everyone learned to
ignore. It is 0 as of `bf172a4`.

Clearing typecheck was not enough. The very first run went red anyway, on
`pnpm run lint` — 193 errors that had accumulated precisely because nothing had
ever enforced them. 187 were mechanical; the rest are described in the PR that
cleared them. The general shape is worth remembering: **a gate that has never
run is not passing, it is unmeasured**, and every check it would have made has
been quietly accruing debt.

Enabling Actions also armed `docker.yaml`, which upstream fires on every push
to main to publish a public multi-platform image to ghcr.io. Nimbus does not
consume ghcr, so that was retriggered to `v*` tags only before the first merge
— an unused public artifact and ~15 minutes of Actions per merge, otherwise.
When enabling workflows on a fork, read *every* workflow's trigger, not just
the one you wanted.

Note `*.md` is gitignored repo-wide (inherited from upstream), so this file and
every other tracked doc needs `git add -f`.
