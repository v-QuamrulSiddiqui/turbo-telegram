import { shortlistReferences } from "./reviewer.js";
import { COPILOT_CHAT_ENDPOINT } from "./copilot-auth.js";

// Copilot / OpenAI-compatible review engine. Instead of matching an issue title
// against reference bugs, this sends the fully understood issue (title, actual and
// expected result, and any code snippet) to a language model together with the WCAG
// criteria and a shortlist of reference bugs from the dataset, then asks the model to
// pick the most suitable WCAG success criterion, a severity, a justification, and the
// most relevant reference — all grounded in the provided dataset.
//
// Two providers are supported:
//  - "copilot": GitHub Copilot via device-flow sign-in (no API key). The caller resolves
//    a short-lived Copilot token and passes it in as config.token with config.headers.
//  - "custom": any OpenAI-compatible chat/completions endpoint with a Bearer token.

export const AI_CONFIG_KEY = "wcagReviewerAiConfig";

export const DEFAULT_AI_CONFIG = {
  enabled: false,
  provider: "copilot",
  // Custom-provider fields (ignored for the copilot provider):
  endpoint: "",
  token: "",
  model: "gpt-4o",
  maxReferences: 15
};

function truncate(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Builds the compact, dataset-grounded context sent to the model. Kept pure so it can
// be unit tested without any network access.
export function buildReviewContext(input, dataset, config = {}) {
  const maxRefs = config.maxReferences || DEFAULT_AI_CONFIG.maxReferences;
  const criteria = (dataset.criteria || []).map((criterion) => ({
    id: criterion.id,
    title: criterion.title,
    summary: truncate(criterion.summary, 220)
  }));
  const references = shortlistReferences(input, dataset, maxRefs).map((bug) => ({
    id: String(bug.id),
    title: bug.title,
    reportedWcag: bug.reportedWcag || "",
    updated: bug.updated || "",
    severityReasoning: truncate(bug.severityReasoning, 240),
    conclusion: truncate(bug.conclusion, 240)
  }));
  return { criteria, references };
}

const SYSTEM_PROMPT = `You are an expert web accessibility (a11y) engineer who triages GitHub accessibility bug reports against the WCAG 2.x success criteria.
You will receive one bug report (title, description, actual result, expected result, and an optional code snippet), the list of WCAG success criteria available in the reviewer's dataset, and a shortlist of previously triaged reference bugs from that dataset.
Deeply understand the report first: what the user actually experiences, what should happen instead, and what the code snippet (when present) demonstrates about the underlying markup or behaviour.
Before deciding validity, CROSS-VALIDATE the root cause to increase accuracy. Determine which of the following the report really is:
 - "Actual accessibility issue": a genuine defect in the page/app under test that a WCAG criterion covers and the author can fix.
 - "Known browser/device/screen reader issue": the behaviour is caused by a documented bug or limitation in the browser, operating system, device, or assistive technology (screen reader) itself — NOT the page under test — so it is not actionable as an app WCAG failure.
 - "Expected behaviour of the screen reader/control": the behaviour is the correct, by-design operation of the screen reader, the native control, or the platform (for example standard focus order, announcement patterns, or interaction model), so it is not a defect.
 - "Needs investigation": there is not enough evidence to classify confidently.
Use this classification to sanity-check validity and severity: a known platform/AT issue or expected behaviour must NOT be reported as a valid app WCAG failure, and should lower confidence in any WCAG/severity suggestion.
Then decide, grounded in the WCAG definitions and the provided dataset:
1. classification — exactly one of the four quoted phrases above.
2. classificationReason — 1 to 2 sentences explaining the classification, naming the specific browser, device, screen reader, control, or platform behaviour when relevant.
3. validity — exactly one of: "Valid", "Invalid", "Valid as a usability issue, not a WCAG failure", or "Needs more information". It MUST be consistent with the classification (a known platform/AT issue or expected behaviour is not "Valid").
4. suggestedWcag — the id of the single most appropriate WCAG success criterion (for example "2.4.7"), chosen ONLY from the provided WCAG criteria list. Use "" when none genuinely applies.
5. suggestedSeverity — one of "Severity-1", "Severity-2", "Severity-3", "Severity-4", or "" when invalid or unknown. Judge it by user impact and whether a workaround exists.
6. justification — 2 to 4 sentences explaining WHY this criterion and severity fit, citing the concrete evidence in the report and the meaning of the criterion.
7. referenceBugId — the id (from the shortlist) of the single most relevant reference bug, or null when none is a good match.
8. confidence — an integer from 0 to 100 for your overall confidence.
Respond with ONLY a JSON object containing exactly these keys: classification, classificationReason, validity, suggestedWcag, suggestedSeverity, justification, referenceBugId, confidence. No markdown fences and no extra prose.`;

function buildUserPrompt(input, context) {
  return JSON.stringify({
    bug: {
      title: input.title || "",
      description: input.body || "",
      actualResult: input.actualResult || "",
      expectedResult: input.expectedResult || "",
      codeSnippet: input.codeSnippet || "",
      citedWcag: input.citedWcag || "",
      citedSeverity: input.citedSeverity || ""
    },
    wcagCriteria: context.criteria,
    referenceBugs: context.references
  });
}

// Extracts a JSON object from the model response, tolerating code fences or stray prose.
export function parseModelJson(content) {
  const text = String(content || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("The Copilot model did not return a JSON object.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeSeverity(value) {
  const match = String(value || "").match(/([1-4])/);
  return match ? `Severity-${match[1]}` : "";
}

// Canonical cross-validation classifications the model may return. Free-form text from the
// model is matched back onto one of these so the UI and feedback stay consistent.
export const CLASSIFICATIONS = {
  ACTUAL: "Actual accessibility issue",
  KNOWN_PLATFORM: "Known browser/device/screen reader issue",
  EXPECTED: "Expected behaviour of the screen reader/control",
  INVESTIGATE: "Needs investigation"
};

// Maps the model's classification text onto one of the canonical CLASSIFICATIONS labels.
export function normalizeClassification(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (text.includes("expected")) return CLASSIFICATIONS.EXPECTED;
  if (text.includes("known") || text.includes("browser") || text.includes("device")
    || text.includes("screen reader issue") || text.includes("platform")
    || text.includes("assistive technology")) {
    return CLASSIFICATIONS.KNOWN_PLATFORM;
  }
  if (text.includes("actual") || text.includes("genuine") || text.includes("real")) {
    return CLASSIFICATIONS.ACTUAL;
  }
  if (text.includes("investigat") || text.includes("more info") || text.includes("unclear")) {
    return CLASSIFICATIONS.INVESTIGATE;
  }
  return String(value).trim();
}

// Maps the raw model JSON onto the result shape the side panel already renders.
export function mapModelResult(parsed, input, dataset) {
  const validity = String(parsed.validity || "Needs more information").trim();
  const isInvalid = /^invalid$/i.test(validity);
  const wcagId = String(parsed.suggestedWcag || "")
    .match(/[1-4]\.\d{1,2}\.\d{1,2}/)?.[0] || "";
  const criterion = wcagId
    ? (dataset.criteria || []).find((item) => item.id === wcagId)
    : null;
  const reference = parsed.referenceBugId != null && parsed.referenceBugId !== ""
    ? (dataset.bugs || []).find(
      (bug) => String(bug.id) === String(parsed.referenceBugId).replace(/^#/, "")
    ) || null
    : null;
  const confidence = Number.isFinite(Number(parsed.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(parsed.confidence))))
    : null;
  const justification = String(parsed.justification || "").trim();
  const classification = normalizeClassification(parsed.classification);
  const classificationReason = String(parsed.classificationReason || "").trim();
  const crossValidationLine = classification
    ? `Cross-validation: ${classification}${classificationReason ? ` — ${classificationReason}` : ""}`
    : "";

  if (isInvalid) {
    const feedback = [];
    if (crossValidationLine) feedback.push(crossValidationLine);
    feedback.push(`Invalid bug justification: ${justification
      || "Copilot determined the evidence does not demonstrate a WCAG failure."}`);
    if (confidence != null) feedback.push(`Copilot confidence: ${confidence}%`);
    return {
      validity,
      classification,
      classificationReason,
      citedWcag: "",
      suggestedWcag: "",
      citedSeverity: "",
      suggestedSeverity: "",
      reference,
      feedback: feedback.join("\n"),
      confidence,
      source: "copilot"
    };
  }

  const feedback = [];
  if (crossValidationLine) feedback.push(crossValidationLine);
  if (justification) feedback.push(`Justification: ${justification}`);
  if (reference) {
    const parts = [`Reference #${reference.id}`];
    if (reference.updated) parts.push(`Updated WCAG/Severity: ${reference.updated}`);
    feedback.push(parts.join(" — "));
  }
  if (confidence != null) feedback.push(`Copilot confidence: ${confidence}%`);
  feedback.push("Suggested by Copilot analysis of the issue against the WCAG dataset.");

  return {
    validity,
    classification,
    classificationReason,
    citedWcag: input.citedWcag || "Not provided",
    suggestedWcag: criterion
      ? `${criterion.id} ${criterion.title}`
      : (wcagId || "No confident WCAG suggestion available"),
    citedSeverity: normalizeSeverity(input.citedSeverity)
      || "No Severity-1 to Severity-4 label found",
    suggestedSeverity: normalizeSeverity(parsed.suggestedSeverity),
    reference,
    feedback: feedback.join("\n"),
    confidence,
    source: "copilot"
  };
}

// Sends one issue to a Copilot/OpenAI-compatible endpoint and returns a rendered review
// result. The caller passes a resolved config: for the copilot provider, config.endpoint
// defaults to the Copilot chat endpoint and config.token is a short-lived Copilot token
// with config.headers carrying the required editor identification headers. fetchImpl is
// injectable for testing.
export async function reviewIssueWithAI(input, dataset, config, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) throw new Error("No fetch implementation is available.");
  const cfg = { ...DEFAULT_AI_CONFIG, ...(config || {}) };
  if (!cfg.token) throw new Error("No Copilot credential available; sign in or add a token in Settings.");
  const endpoint = cfg.endpoint || COPILOT_CHAT_ENDPOINT;

  const context = buildReviewContext(input, dataset, cfg);
  const requestBody = {
    model: cfg.model,
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input, context) }
    ]
  };

  const response = await doFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
      ...(cfg.headers || {})
    },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Copilot request failed (${response.status}). ${truncate(detail, 200)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Copilot returned an empty response.");
  return mapModelResult(parseModelJson(content), input, dataset);
}
