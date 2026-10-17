// Race accessibility review — GitHub Action entry point.
//
// Triggered by a `/race` comment on an issue or PR. The review is powered by GitHub
// Copilot ONLY: the issue is analysed by Copilot (lib/ai-reviewer.js) against the WCAG
// dataset, and the result is posted back as a comment via the GitHub REST API. There is
// no offline/heuristic fallback — if Copilot cannot be reached, a clear failure comment
// is posted instead of a lower-quality guess.
//
// Required environment (provided by the workflow):
//   GITHUB_TOKEN          - Actions token (issues/pull-requests: write). Posts the comment.
//   COPILOT_GITHUB_TOKEN  - GitHub OAuth/user token of an account with a Copilot
//                           subscription; exchanged for a short-lived Copilot token.
//   GITHUB_EVENT_PATH     - issue_comment event payload (set by Actions).
//   GITHUB_REPOSITORY     - "owner/repo" (set by Actions).
// Optional:
//   COPILOT_MODEL         - Copilot chat model id (default "gpt-4o").
//   SHARED_DATASET_URL    - fetch the shared/central dataset instead of the bundled copy.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { reviewerInternals } from "../lib/reviewer.js";
import { reviewIssueWithAI, DEFAULT_AI_CONFIG } from "../lib/ai-reviewer.js";
import { COPILOT_TOKEN_URL, COPILOT_CHAT_ENDPOINT, copilotHeaders } from "../lib/copilot-auth.js";

const COMMAND = "/race";
const __dirname = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readEventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) fail("GITHUB_EVENT_PATH is not set; this must run inside GitHub Actions.");
  return readFile(path, "utf8").then((raw) => JSON.parse(raw));
}

// Pulls a fenced code block (if any) out of the markdown body.
export function extractCodeSnippet(body) {
  const match = String(body || "").match(/```[\w-]*\n([\s\S]*?)```/);
  return match ? match[1].trim() : "";
}

// Turns the raw issue/PR text into the input shape the review engine expects, reusing the
// same section/WCAG/severity parsers the extension uses.
export function buildReviewInput(issue) {
  const body = issue.body || "";
  const { extractIssueSection, extractWcag, extractSeverity } = reviewerInternals;
  const citedWcag = extractWcag(`${issue.title} ${body}`).map((id) => `WCAG ${id}`).join(", ");
  return {
    bugId: String(issue.number || ""),
    title: issue.title || "",
    body,
    actualResult: extractIssueSection(body, "Actual Result"),
    expectedResult: extractIssueSection(body, "Expected Result"),
    codeSnippet: extractCodeSnippet(body),
    citedWcag,
    citedSeverity: extractSeverity(`${issue.title} ${body}`) || "",
    alternateSeverityReasoning: "",
    labels: (issue.labels || []).map((label) => (typeof label === "string" ? label : label.name))
  };
}

async function loadDataset() {
  const url = process.env.SHARED_DATASET_URL;
  if (url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Shared dataset fetch failed (${response.status}).`);
    return response.json();
  }
  const raw = await readFile(join(__dirname, "..", "data", "dataset.json"), "utf8");
  return JSON.parse(raw);
}

// Exchanges the Copilot-licensed GitHub token for a short-lived Copilot chat token.
export async function getCopilotSessionToken(oauthToken, fetchImpl = fetch) {
  if (!oauthToken) {
    throw new Error("COPILOT_GITHUB_TOKEN is not set. Add a repository secret holding a GitHub token for an account with GitHub Copilot.");
  }
  const response = await fetchImpl(COPILOT_TOKEN_URL, {
    headers: { Authorization: `token ${oauthToken}`, Accept: "application/json" }
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub Copilot access was rejected. Confirm the account behind COPILOT_GITHUB_TOKEN has an active Copilot subscription.");
  }
  if (!response.ok) throw new Error(`Could not obtain a Copilot token (${response.status}).`);
  const data = await response.json();
  if (!data.token) throw new Error("GitHub did not return a Copilot token; a Copilot subscription may be required.");
  return data.token;
}

// Copilot-only: always reviews with Copilot; any failure propagates to the caller.
export async function runReview(input, dataset, env = process.env, fetchImpl = fetch) {
  const token = await getCopilotSessionToken(env.COPILOT_GITHUB_TOKEN, fetchImpl);
  const config = {
    ...DEFAULT_AI_CONFIG,
    enabled: true,
    provider: "copilot",
    endpoint: COPILOT_CHAT_ENDPOINT,
    model: env.COPILOT_MODEL || "gpt-4o",
    headers: copilotHeaders(),
    token
  };
  return reviewIssueWithAI(input, dataset, config, fetchImpl);
}

export function formatFailureComment(message) {
  return [
    "## ♿ Race accessibility review",
    "",
    "⚠️ The Copilot review could not be completed, so no result was produced.",
    "",
    `> ${String(message).split("\n")[0]}`,
    "",
    `<sub>Posted by the \`${COMMAND}\` slash command · powered by GitHub Copilot</sub>`
  ].join("\n");
}
function referenceWcagSeverity(bug) {
  if (!bug) return "";
  return bug.updated || [bug.reportedWcag, bug.reportedSeverity].filter(Boolean).join(", ");
}

// Renders the review result as a GitHub-flavoured markdown comment.
export function formatComment(result, input) {
  const lines = [];
  lines.push("## ♿ Race accessibility review");
  lines.push("");
  lines.push(`**Issue reviewed:** ${input.title || `#${input.bugId}`}`);
  lines.push(`**Validity:** ${result.validity}`);
  if (result.classification) {
    const reason = result.classificationReason ? ` — ${result.classificationReason}` : "";
    lines.push(`**Cross-validation:** ${result.classification}${reason}`);
  }
  lines.push("");

  if (result.validity !== "Invalid") {
    const bug = result.reference;
    const wcagSeverity = referenceWcagSeverity(bug);
    lines.push("| | Cited | Suggested |");
    lines.push("| --- | --- | --- |");
    lines.push(`| **WCAG** | ${result.citedWcag || "—"} | ${result.suggestedWcag || "—"} |`);
    lines.push(`| **Severity** | ${result.citedSeverity || "—"} | ${result.suggestedSeverity || "—"} |`);
    lines.push("");
    if (bug) {
      lines.push(`**Reference bug:** #${bug.id}${wcagSeverity ? ` (${wcagSeverity})` : ""}`);
      lines.push("");
    }
  }

  const feedback = String(result.feedback || "").split("\n").filter(Boolean);
  if (feedback.length) {
    lines.push("**Feedback / Suggestion**");
    lines.push("");
    for (const line of feedback) lines.push(`- ${line}`);
    lines.push("");
  }

  const confidence = result.confidence != null ? ` · confidence: ${result.confidence}%` : "";
  lines.push(`<sub>Posted by the \`${COMMAND}\` slash command · powered by GitHub Copilot${confidence}</sub>`);
  return lines.join("\n");
}

async function postComment(owner, repo, issueNumber, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is not set; cannot post the review comment.");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "race-slash-command"
      },
      body: JSON.stringify({ body })
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    fail(`Failed to post comment (${response.status}). ${detail.slice(0, 300)}`);
  }
}

export async function main() {
  const event = await readEventPayload();
  const commentBody = event.comment?.body || "";
  if (!new RegExp(`(^|\\s)${COMMAND}\\b`, "i").test(commentBody)) {
    console.log(`No ${COMMAND} command found in the comment; nothing to do.`);
    return;
  }
  const issue = event.issue;
  if (!issue) fail("The event payload has no issue/PR to review.");

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo) fail("GITHUB_REPOSITORY is not set to owner/repo.");

  const input = buildReviewInput(issue);
  const dataset = await loadDataset();
  let result;
  try {
    result = await runReview(input, dataset);
  } catch (error) {
    // Copilot-only: surface the failure to the user instead of guessing with a heuristic.
    await postComment(owner, repo, issue.number, formatFailureComment(error.message));
    fail(`Copilot review failed: ${error.message}`);
  }
  await postComment(owner, repo, issue.number, formatComment(result, input));
  console.log(`Posted Race review on #${issue.number} (validity: ${result.validity}).`);
}

// Only auto-run when invoked directly (node scripts/race-review.mjs), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error.stack || error.message));
}