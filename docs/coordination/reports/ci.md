# CI report: Realm-Keeper workflows adapted, repository made public

Date: 2026-11-13. Branch `ci/realm-keeper-actions`.

## Source

ArnauFauquer/Realm-Keeper `main`: `.github/workflows/tests.yml`, `build-and-push.yml` and `helm.yml`
(no composite actions or scripts).

## What was taken

| From Realm-Keeper | In Blob |
| --- | --- |
| Actions pinned by commit SHA with a `# vN` comment | `ci.yml`, `image.yml` (same SHAs for checkout, setup-node and the docker actions; `astral-sh/setup-uv` v5.4.2) |
| Workflow `permissions: contents: read`; `packages: write` only on the push job | `image.yml` job `build` |
| `persist-credentials: false`, `timeout-minutes`, `ubuntu-24.04` | every job |
| Image only from a green commit: the build calls the tests workflow (`workflow_call`) first | `image.yml` job `tests` calls `ci.yml`; `build` needs it |
| `docker/metadata-action` OCI labels, GHA build cache | kept |

Observation from the first e2e runs on GitHub: on the 2-core runner the page's capture starts about 1.1 s
after `getUserMedia` resolves (a 2 s recording arrived as 813-914 ms, twice; locally it is about 2 s). The
"normal turn" spec now records 3 s with the same bounds (1.2-4 s). Whether the tablet loses the start of an
utterance the same way is not known; worth a look when testing on the tablet.

New in Blob: an `e2e` job (Playwright against the mock backend, 26 specs, about 2 min), and one CI run per
commit: push runs for branches of this repository, `pull_request` runs only for forks.

Not taken:

- `release-please` and semver tags: Blob deploys by `sha-<short>` pinned in the home_lab chart.
- Multi-arch (`linux/arm64`): the image is CUDA-based and runs on kube1 (amd64).
- `helm.yml`: the Blob chart lives in home_lab (`faukinator/blob`, branch `feat/blob`); there is no chart
  in this repo to lint. The chart was already checked with `helm lint` and `kubeconform` (see `deploy.md`).
- `CODEOWNERS`: single-owner repository.

## Public-repo safety

- No `pull_request_target`, no `workflow_run`. Fork PRs run `ci.yml` with a read-only token and no secrets.
- The only secret used is `GITHUB_TOKEN`, in `image.yml`, which runs only on pushes to `main` (and manual
  runs, which the `build` job also restricts to `main`).
- `actionlint` 1.7.7: clean. `zizmor` 1.32.0 (offline): one low "help" (suggests `$/` self-repository syntax).

## Secret audit (before the visibility change)

Scanned a `--mirror` clone of GitHub (all branches, renovate branches and `refs/pull/*`, 70 commits) and the
local repository with all refs.

- gitleaks 8.28.0 (Docker): remote mirror, no leaks. Local `--all`: 204 hits, all in `review_context/`
  (third-party pages saved for the design review) inside local T3 checkpoint refs (`refs/t3/...`). Those refs
  and that directory (in `.gitignore`) were never pushed (`git ls-remote` lists only heads and `refs/pull/*`).
- trufflehog 3.90.8 (Docker) on the mirror: 1168 chunks, 0 verified, 0 unverified.
- Manual greps of the full history: no GitHub/AWS/Slack/OpenAI token shapes, private keys or JWTs; no `.env`,
  database or voice recording was ever committed (`.env.example` holds `change-me` placeholders only).
- Personal data found, judged fine to publish: the owner's own email in the "Author" line of the design
  documents (the same address is already public in Realm-Keeper commits and is in this repo's commit
  metadata anyway); the home domain `faukinator.com` (already in the owner's public repositories); the LAN
  address of Traefik (192.168.1.15, private range) in `reports/deploy.md`.

## Visibility

- Repository: public (`gh repo edit ... --visibility public`).
- Package `ghcr.io/arnaufauquer/meet_blob`: see the session's final message. The `gh` token has no
  `read:packages`/`write:packages`, and GitHub has no API to change a package's visibility. Manual step:
  https://github.com/users/ArnauFauquer/packages/container/meet_blob/settings, "Danger Zone", "Change
  visibility", "Public".

## Consequence for the deployment

With a public image the `github-docker-credentials` pull secret is not needed in namespace `blob`.
`integration.md`, `deploy/README.md` and `docs/notes/deploy.md` say so. The home_lab chart still names the
secret in `imagePullSecrets`; setting it to `[]` there is optional (a missing secret only makes the kubelet
warn). home_lab was not touched.
