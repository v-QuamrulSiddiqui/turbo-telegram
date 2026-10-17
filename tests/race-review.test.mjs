import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewInput,
  extractCodeSnippet,
  formatComment,
  formatFailureComment,
  getCopilotSessionToken,
  runReview
} from "../scripts/race-review.mjs";

const issue = {
  number: 42,
  title: "Keyboard focus is not visible on the submit button",
  body: [
    "Actual Result:",
    "No visible focus indicator when tabbing to the button. This looks like WCAG 2.4.7 and is Sev-2.",
    "",
    "Expected Result:",
    "A clearly visible focus indicator.",
    "",
    "```css",
    "button:focus { outline: none; }",
    "```"
  ].join("\n"),
  labels: [{ name: "accessibility" }]
};

test("extractCodeSnippet pulls a fenced code block", () => {
  assert.equal(extractCodeSnippet(issue.body), "button:focus { outline: none; }");
  assert.equal(extractCodeSnippet("no code here"), "");
});

test("buildReviewInput parses sections, WCAG and severity from the body", () => {
  const input = buildReviewInput(issue);
  assert.equal(input.bugId, "42");
  assert.match(input.actualResult, /No visible focus indicator/);
  assert.match(input.expectedResult, /clearly visible focus indicator/);
  assert.equal(input.codeSnippet, "button:focus { outline: none; }");
  assert.match(input.citedWcag, /2\.4\.7/);
  assert.match(input.citedSeverity, /2/);
  assert.deepEqual(input.labels, ["accessibility"]);
});

test("formatComment renders a valid review with the comparison table and cross-validation", () => {
  const result = {
    validity: "Valid",
    classification: "Actual accessibility issue",
    classificationReason: "The app removes the focus outline in its own CSS.",
    citedWcag: "WCAG 2.4.7",
    suggestedWcag: "2.4.7 Focus Visible",
    citedSeverity: "Severity-2",
    suggestedSeverity: "Severity-2",
    reference: { id: "9339", updated: "WCAG 2.4.7 Focus Visible, Sev-2" },
    feedback: "Cross-validation: Actual accessibility issue\nJustification: Focus outline removed.",
    confidence: 90,
    source: "copilot"
  };
  const md = formatComment(result, buildReviewInput(issue));
  assert.match(md, /## ♿ Race accessibility review/);
  assert.match(md, /\*\*Validity:\*\* Valid/);
  assert.match(md, /\*\*Cross-validation:\*\* Actual accessibility issue/);
  assert.match(md, /\| \*\*WCAG\*\* \| WCAG 2\.4\.7 \| 2\.4\.7 Focus Visible \|/);
  assert.match(md, /\*\*Reference bug:\*\* #9339/);
  assert.match(md, /confidence: 90%/);
});

test("formatComment omits the table for invalid issues", () => {
  const result = {
    validity: "Invalid",
    classification: "Expected behaviour of the screen reader/control",
    feedback: "Invalid bug justification: Works as designed.",
    source: "copilot"
  };
  const md = formatComment(result, buildReviewInput(issue));
  assert.doesNotMatch(md, /\| \*\*WCAG\*\*/);
  assert.match(md, /\*\*Validity:\*\* Invalid/);
  assert.match(md, /Expected behaviour of the screen reader\/control/);
});

const tinyDataset = {
  criteria: [{ id: "2.4.7", title: "Focus Visible", summary: "Focus is visible." }],
  documents: [],
  bugs: []
};

test("getCopilotSessionToken requires a token and surfaces rejected access", async () => {
  await assert.rejects(() => getCopilotSessionToken(""), /COPILOT_GITHUB_TOKEN/);
  await assert.rejects(
    () => getCopilotSessionToken("x", async () => ({ ok: false, status: 403 })),
    /subscription/i
  );
});

test("runReview uses Copilot only: exchanges the token and calls the Copilot endpoint", async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push(url);
    if (String(url).includes("copilot_internal")) {
      return { ok: true, status: 200, json: async () => ({ token: "session-token" }) };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          classification: "Actual accessibility issue",
          validity: "Valid",
          suggestedWcag: "2.4.7",
          suggestedSeverity: "Severity-2",
          justification: "Outline removed.",
          referenceBugId: null,
          confidence: 88
        }) } }]
      })
    };
  };
  const result = await runReview(buildReviewInput(issue), tinyDataset, { COPILOT_GITHUB_TOKEN: "oauth" }, fakeFetch);
  assert.equal(result.source, "copilot");
  assert.ok(calls.some((u) => String(u).includes("api.githubcopilot.com")));
  assert.ok(!calls.some((u) => String(u).includes("models.github.ai")));
});

test("runReview has no heuristic fallback: Copilot failure propagates", async () => {
  const failing = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    () => runReview(buildReviewInput(issue), tinyDataset, { COPILOT_GITHUB_TOKEN: "oauth" }, failing),
    /Copilot token/
  );
});

test("formatFailureComment explains the failure", () => {
  const md = formatFailureComment("Copilot access was rejected.\nstack");
  assert.match(md, /could not be completed/);
  assert.match(md, /Copilot access was rejected\./);
  assert.doesNotMatch(md, /stack/);
});
