// Race accessibility review — GitHub Action entry point.
//
// Triggered by a `/race` comment on an issue or PR. The review is powered by GitHub
// Copilot ONLY, run through the GitHub Copilot CLI using the workflow's built-in
// GITHUB_TOKEN (no PAT or extra secret). The issue is analysed by Copilot against the WCAG
// dataset and the result is posted back as a comment via the GitHub REST API. There is no
// heuristic fallback — if Copilot fails, a clear failure comment is posted instead.
//
// Requirements: org policy "Allow use of Copilot CLI billed to the organization" and the
// workflow permission `copilot-requests: write`.
//
// Environment (provided by the workflow):
//   GITHUB_TOKEN       - Actions token; authenticates Copilot CLI and posts the comment.
//   GITHUB_EVENT_PATH  - issue_comment event payload (set by Actions).
//   GITHUB_REPOSITORY  - "owner/repo" (set by Actions).
// Optional:
//   COPILOT_MODEL      - model passed to `copilot --model` (CLI default when unset).
//   SHARED_DATASET_URL - fetch the shared/central dataset instead of the bundled copy.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { reviewerInternals } from "../lib/reviewer.js";
import { buildReviewPrompt, parseModelJson, mapModelResult } from "../lib/ai-reviewer.js";
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

const execFileAsync = promisify(execFile);

// Runs the Copilot CLI non-interactively. Authentication comes from GITHUB_TOKEN in the
// environment. No --allow-tool flags are passed, so Copilot cannot run shell commands or
// other tools; it can only answer the prompt (safe against prompt injection in issue text).
export async function runCopilotCli(prompt, env = process.env, execImpl = execFileAsync) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not available to authenticate Copilot CLI.");
  const args = ["-p", prompt, "-s"];
  if (env.COPILOT_MODEL) args.push("--model", env.COPILOT_MODEL);
  try {
    const { stdout } = await execImpl("copilot", args, {
      env: { ...env, GITHUB_TOKEN: env.GITHUB_TOKEN },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    });
    return String(stdout || "");
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    throw new Error(
      `Copilot CLI failed. Check the "Allow use of Copilot CLI billed to the organization" policy and the copilot-requests: write permission. ${detail}`
    );
  }
}

// Copilot-only: always reviews with Copilot CLI; any failure propagates to the caller.
export async function runReview(input, dataset, env = process.env, execImpl = execFileAsync) {
  const output = await runCopilotCli(buildReviewPrompt(input, dataset), env, execImpl);
  return mapModelResult(parseModelJson(output), input, dataset);
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