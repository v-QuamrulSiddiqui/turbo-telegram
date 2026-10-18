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

Copy these into the target repository root. Everything except the workflow lives under the
`Bug review extension/` folder:

```
.github/workflows/race.yml            # must stay at the repo root
Bug review extension/
├── scripts/race-review.mjs
├── lib/reviewer.js
├── lib/ai-reviewer.js
├── lib/copilot-auth.js
├── data/dataset.json                 # or use a shared dataset URL (see below)
├── tests/race-review.test.mjs
├── package.json
└── README.md
```

The workflow runs `node "Bug review extension/scripts/race-review.mjs"`.

Commit and push.

## Authentication — no PAT or secret

The review runs through the **GitHub Copilot CLI** inside the Action, authenticated by the
workflow's built-in `GITHUB_TOKEN`. Usage is billed to the organization.

One-time requirements:

1. **Org policy:** Copilot → Policies → **Allow use of Copilot CLI billed to the organization**
   (on by default when the "Copilot CLI" policy is enabled).
2. **Workflow permission:** `copilot-requests: write` (already set in `race.yml`).
3. The repository must be **organization-owned**.

Copilot is run with **no tools allowed**, so issue text (untrusted) cannot make it execute
commands. Only `OWNER`/`MEMBER`/`COLLABORATOR` comments trigger the review, to keep org
billing under control. Add a Copilot CLI session limit and a cost center for spend control.

| Name | Type | Required | Purpose |
| --- | --- | --- | --- |
| `RACE_COPILOT_MODEL` | var | no | Model passed to `copilot --model` (CLI default if unset). |
| `RACE_SHARED_DATASET_URL` | var | no | Central dataset URL so every repo reviews against one shared dataset. |

> If your repo is not org-owned or the policy is off, Copilot CLI also accepts a fine-grained
> PAT with the "Copilot Requests" permission via `COPILOT_GITHUB_TOKEN` (not needed otherwise).
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
