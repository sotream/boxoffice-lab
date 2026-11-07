# Repository settings

What is configured on GitHub for this repository and why. These settings live on GitHub, not in the repository, so they are written down here.

## Ruleset `main protection`

Applies to the default branch (`main`):

| Rule | Effect |
|---|---|
| Required status check `test` | a change reaches `main` through a pull request only after the `test` job of [ci.yml](../.github/workflows/ci.yml) (build, ops check, tests with coverage thresholds, end-to-end suite) is green |
| Block deletion | `main` cannot be deleted |
| Block force pushes | history on `main` cannot be rewritten |

The repository admin role is a bypass actor, so the maintainer can still push directly to `main` (this repository is maintained by one person). Anyone else, and every bot, has to go through a pull request with a green `test`.

## Dependabot and auto-merge

- Allow auto-merge and delete head branches on merge are on.
- For Dependabot pull requests the `automerge` job in `ci.yml` switches on GitHub's native auto-merge (squash) when the update is a patch or minor of an npm or compose dependency. GitHub then merges the pull request itself when the required `test` check passes; a red pull request stays open.
- Major updates are left open on purpose: they are a deliberate move, and for the Postgres, Redis and Redpanda images also a re-measurement of the numbers in the `RESULTS.md` files.
- Updates of GitHub Actions are left to the maintainer as well: the workflow token may not modify workflow files, so it cannot merge them.

## Changing these settings

Ruleset: Settings, Rules, Rulesets. Auto-merge and branch deletion: Settings, General, Pull Requests.
