# Race Accessibility Review — `/race` slash command

A GitHub Actions port of the **WCAG GitHub Bug Reviewer** extension. Instead of a browser
side panel, reviewers trigger the same review engine by commenting **`/race`** on any issue
or pull request, and the bot posts the WCAG review back as a comment.

```
GitHub Issue / PR
      ↓  user comments:  /race
GitHub issue_comment event
      ↓
GitHub Actions  (.github/workflows/race.yml)
      ↓
Race review script  (scripts/race-review.mjs  →  lib/ reviewer + ai-reviewer)
      ↓
GitHub API
      ↓
Posts the result back to the issue / PR
```

## What it does

On `/race`, the workflow:

1. Reacts 👀 to acknowledge the command.
2. Reads the issue/PR title and body, extracting **Actual Result**, **Expected Result**, any
   fenced **code snippet**, and the cited **WCAG** / **severity** (same parsers as the extension).
3. Reviews it with **GitHub Copilot only** (no heuristic fallback):
   - Copilot (`lib/ai-reviewer.js`) understands the report, cross-validates whether it is an *actual accessibility issue*, a *known browser/device/screen-reader issue*, or *expected behaviour*, and suggests WCAG + severity + justification + reference + confidence.
   - If Copilot is unreachable or rejected, a clear failure comment is posted instead of a lower-quality guess.

4. Posts a formatted markdown comment back via the GitHub REST API.

## Install into a repository

Copy these into the target repository root:

```
.github/workflows/race.yml
scripts/race-review.mjs
lib/reviewer.js
lib/ai-reviewer.js
lib/copilot-auth.js
data/dataset.json          # or use a shared dataset URL (see below)
package.json
```

Commit and push. Then add the one required secret (see below) and the command is live.

## Configuration

| Name | Type | Required | Purpose |
| --- | --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | secret | **yes** | GitHub token of an account with an active **Copilot** subscription. Exchanged at run time for a short-lived Copilot token. |
| `RACE_COPILOT_MODEL` | var | no (`gpt-4o`) | Copilot chat model id. |
| `RACE_SHARED_DATASET_URL` | var | no | Central dataset URL so every repo reviews against one shared, versioned dataset. |

> The default `GITHUB_TOKEN` cannot call Copilot, so `COPILOT_GITHUB_TOKEN` is needed.
> Copilot's token-exchange and chat endpoints are GitHub's internal editor APIs (not a
> documented public API) and may change; use a dedicated, least-privilege account/token.
## Shared dataset (parallel use)

Point `RACE_SHARED_DATASET_URL` at a centrally published `dataset.json` (e.g. GitHub Pages /
raw URL produced by the extension's `publish-dataset.yml`). Every repository then reviews
against the same source of truth, in parallel, with no per-repo dataset drift. If unset, the
bundled `data/dataset.json` is used.

## Permissions

The workflow requests the minimum needed:

```yaml
permissions:
  issues: write
  pull-requests: write
  contents: read
```

## Local test

```bash
npm test          # node --test tests/
```

The tests cover body parsing (sections / WCAG / severity / code), and markdown rendering for
valid and invalid results. Node 20+ is required (uses global `fetch`).

## Notes

- `issue_comment` fires for both issues and PRs, so `/race` works on each; PR review uses the
  PR description as the issue body.
- The comment includes the validity, the cross-validation classification, a Cited → Suggested
  WCAG/severity table, the closest reference bug, the feedback list, and a confidence score.
