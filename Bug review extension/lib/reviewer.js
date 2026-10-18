const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "can", "does",
  "for", "from", "has", "have", "in", "is", "it", "not", "of", "on", "or",
  "that", "the", "this", "to", "was", "were", "when", "which", "with"
]);

const TYPO_FIXES = new Map([
  ["accesibility", "accessibility"],
  ["accessiblity", "accessibility"],
  ["annouce", "announce"],
  ["annouced", "announced"],
  ["behaviourr", "behaviour"],
  ["criterial", "criterion"],
  ["descripton", "description"],
  ["grammer", "grammar"],
  ["infromation", "information"],
  ["occurence", "occurrence"],
  ["possibile", "possible"],
  ["recieve", "receive"],
  ["recommand", "recommend"],
  ["refreashed", "refreshed"],
  ["seperately", "separately"],
  ["seperator", "separator"],
  ["wich", "which"]
]);

const WCAG_HINTS = {
  "1.1.1": ["alt text", "alternative text", "image", "icon", "non-text", "decorative"],
  "1.3.1": ["heading", "label", "relationship", "semantic", "table", "list", "fieldset", "landmark", "associated information", "associated label"],
  "1.3.2": ["reading order", "meaningful sequence", "sequence", "browse mode", "information that is not present", "not present on the ui", "extra information announced", "additional information that is not present"],
  "1.3.3": ["shape", "size", "location", "sensory"],
  "1.3.4": ["orientation", "portrait", "landscape"],
  "1.3.5": ["autocomplete", "input purpose"],
  "1.4.1": ["color only", "use of color", "colour only"],
  "1.4.3": ["text contrast", "contrast ratio", "low contrast"],
  "1.4.4": ["resize text", "zoom text", "200%"],
  "1.4.10": ["reflow", "horizontal scroll", "400% zoom", "responsive"],
  "1.4.11": ["non-text contrast", "control contrast", "focus contrast"],
  "1.4.12": ["text spacing", "line height", "letter spacing"],
  "1.4.13": ["hover", "tooltip", "dismissible", "hover or focus"],
  "2.1.1": ["keyboard", "tab key", "keyboard inaccessible", "mouse only"],
  "2.1.2": ["keyboard trap", "focus trap", "cannot escape"],
  "2.1.4": ["character key shortcut", "single key shortcut"],
  "2.2.1": ["timeout", "time limit", "session expires"],
  "2.2.2": ["pause", "stop", "moving", "blinking", "auto update"],
  "2.3.1": ["flash", "flashing", "seizure"],
  "2.4.1": ["skip link", "bypass blocks"],
  "2.4.2": ["page title", "document title"],
  "2.4.3": ["focus order", "tab order", "focus moves"],
  "2.4.4": ["link purpose", "ambiguous link", "not descriptive", "link text is not descriptive", "descriptive link", "vague link text", "generic link text", "link is not descriptive"],
  "2.4.5": ["multiple ways", "find a page"],
  "2.4.6": ["heading text", "label text", "descriptive heading"],
  "2.4.7": ["focus visible", "focus indicator", "focus is not visible", "keyboard focus visibility", "focus visibility", "no visible focus", "focus indicator is not visible", "visible focus indicator", "not visible on selected"],
  "2.4.11": ["focus obscured", "focus hidden"],
  "2.5.1": ["multipoint", "path based gesture", "pinch"],
  "2.5.2": ["pointer cancellation", "down event"],
  "2.5.3": ["label in name", "visible label", "accessible name"],
  "2.5.4": ["motion actuation", "device motion"],
  "2.5.7": ["drag", "dragging"],
  "2.5.8": ["target size", "24 by 24", "touch target"],
  "3.1.1": ["language of page", "html lang"],
  "3.1.2": ["language of parts", "lang attribute"],
  "3.2.1": ["on focus", "focus causes"],
  "3.2.2": ["on input", "input causes"],
  "3.2.3": ["consistent navigation"],
  "3.2.4": ["consistent identification"],
  "3.2.6": ["consistent help"],
  "3.3.1": ["error identification", "error not identified"],
  "3.3.2": ["label or instruction", "instructions", "required field"],
  "3.3.3": ["error suggestion", "correction suggestion"],
  "3.3.4": ["error prevention", "legal", "financial", "delete data"],
  "3.3.7": ["redundant entry", "re-enter"],
  "3.3.8": ["accessible authentication", "cognitive function", "password puzzle"],
  "4.1.2": ["name role value", "accessible name", "role", "state", "aria"],
  "4.1.3": ["status message", "live region", "toast message", "success message", "error message announced", "aria-live", "dynamically updated message"]
};

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}.#-]+/gu, " ").trim();
}

const TRAILING_SECTION_HEADINGS = ["Expected Result", "References", "Test Environment"];

// Strips any of the known section headings (and everything after them) that may have
// leaked into the Alternate Severity Reasoning text before it is echoed in feedback.
function stripTrailingSections(text) {
  if (!text) return text;
  const escaped = TRAILING_SECTION_HEADINGS
    .map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const boundary = new RegExp(`\\n\\s*#{0,6}\\s*\\*{0,2}(?:${escaped})\\*{0,2}:?\\s*(?:\\n|$)`, "i");
  const match = text.match(boundary);
  return (match ? text.slice(0, match.index) : text).trim();
}

function tokens(value) {
  return [...new Set(normalize(value).split(/\s+/).filter(
    (token) => token.length > 2 && !STOP_WORDS.has(token)
  ))];
}

function scoreText(query, candidate) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return 0;
  const candidateText = ` ${normalize(candidate)} `;
  return queryTokens.reduce((score, token) => {
    const exact = candidateText.includes(` ${token} `);
    const partial = !exact && token.length > 5 && candidateText.includes(token);
    return score + (exact ? 3 : partial ? 1 : 0);
  }, 0) / queryTokens.length;
}

function extractWcag(value) {
  const matches = String(value || "").match(/\b[1-4]\.\d{1,2}\.\d{1,2}\b/g) || [];
  return [...new Set(matches)];
}

function extractSeverity(value) {
  const match = String(value || "").match(/\b(?:severity|sev)[\s:-]*([1-4])\b/i);
  return match ? `Severity-${match[1]}` : "";
}

function extractIssueSection(body, sectionName) {
  const text = String(body || "");
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `(?:^|\\n)#{1,6}\\s*${escaped}\\s*:?[ \\t]*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`,
      "i"
    ),
    new RegExp(
      `(?:^|\\n)\\*\\*${escaped}\\s*:?\\*\\*[ \\t]*([\\s\\S]*?)(?=\\n\\*\\*[^\\n]+\\*\\*|\\n#{1,6}\\s|$)`,
      "i"
    ),
    new RegExp(
      `(?:^|\\n)${escaped}\\s*:[ \\t]*([\\s\\S]*?)(?=\\n(?:expected result|steps? to reproduce|environment|additional information)\\s*:|\\n#{1,6}\\s|$)`,
      "i"
    )
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function findCriterion(dataset, id) {
  return dataset.criteria.find((criterion) => criterion.id === id);
}

function suggestWcag(text, dataset) {
  const scores = dataset.criteria.map((criterion) => {
    const hints = WCAG_HINTS[criterion.id] || [];
    const hintScore = hints.reduce(
      (score, hint) => score + (normalize(text).includes(normalize(hint)) ? 6 : 0),
      0
    );
    const contentScore = scoreText(text, `${criterion.title} ${criterion.summary || ""}`);
    // Also search the full WCAG document content for deeper matching
    const doc = dataset.documents.find((d) => d.file === criterion.file);
    const docScore = doc ? scoreText(text, doc.content) * 0.5 : 0;
    return { criterion, score: hintScore + contentScore + docScore };
  }).sort((a, b) => b.score - a.score);

  return scores.find((item) => item.score > 0)?.criterion || null;
}

function suggestWcagFromDocs(title, fullText, dataset, actualResult = "") {
  // Score the bug title (and Actual Result, when available) against WCAG criteria using
  // hints, titles, and doc content. Actual Result often contains the concrete symptom detail
  // (e.g. "browse mode", "focus is not visible") that the title alone omits, so hints must be
  // checked against both to avoid missing the correct criterion.
  const hintSourceNorm = normalize(`${title} ${actualResult}`);
  const scores = dataset.criteria.map((criterion) => {
    const hints = WCAG_HINTS[criterion.id] || [];
    const hintScore = hints.reduce(
      (score, hint) => score + (hintSourceNorm.includes(normalize(hint)) ? 8 : 0),
      0
    );
    const titleScore = scoreText(title, `${criterion.title} ${criterion.summary || ""}`);
    const doc = dataset.documents.find((d) => d.file === criterion.file);
    const docScore = doc ? scoreText(title, doc.content) * 0.4 : 0;
    const overlapText = [
      criterion.title,
      criterion.summary,
      ...(WCAG_HINTS[criterion.id] || []),
      doc?.title,
      doc?.content
    ].filter(Boolean).join(" ");
    const titleOverlap = Math.max(
      titleTokenCoverage(title, overlapText),
      actualResult ? titleTokenCoverage(actualResult, overlapText) : 0
    );
    const actualResultScore = actualResult
      ? scoreText(actualResult, overlapText) * 0.8
      : 0;
    // Also check full text but at lower weight
    const fullTextScore = scoreText(fullText, `${criterion.title} ${criterion.summary || ""}`) * 0.3;
    return {
      criterion,
      titleOverlap,
      score: hintScore + titleScore + docScore + fullTextScore + actualResultScore
    };
  }).sort((a, b) => b.score - a.score);

  const best = scores[0];
  return best && best.score > 0
    ? best
    : { criterion: null, score: 0, titleOverlap: 0 };
}

function suggestSeverity(text, hasWcagFailure) {
  const value = normalize(text);
  if (/(seizure|migraine|bodily harm|motion sickness|entire (product|site|app)|core scenario)/.test(value)
      && /(no workaround|cannot|unable|blocked)/.test(value)) {
    return "Severity-1";
  }
  if (/(core scenario|non-core scenario|significant delay|significant frustration|cannot complete|unable to complete|blocked)/.test(value)) {
    return "Severity-2";
  }
  if (hasWcagFailure) return "Severity-3";
  return "Severity-4";
}

function analyzeAlternateSeverity(reasoning, issueText, hasWcagFailure) {
  const explicitSeverity = extractSeverity(reasoning);
  if (explicitSeverity) return explicitSeverity;
  const value = normalize(reasoning);
  if (/(usability|usable|best effort|does not fail (wcag|mas)|no wcag failure)/.test(value)) {
    return "Severity-4";
  }
  return suggestSeverity(`${reasoning} ${issueText}`, hasWcagFailure);
}

function titleSimilarity(a, b) {
  const aTokens = tokens(a);
  const bTokens = tokens(b);
  if (!aTokens.length || !bTokens.length) return 0;
  const shared = aTokens.filter((t) => bTokens.includes(t)).length;
  return shared / Math.max(aTokens.length, bTokens.length);
}

function titleTokenCoverage(title, candidate) {
  const titleTokens = tokens(title);
  if (!titleTokens.length) return 0;
  const candidateTokens = new Set(tokens(candidate));
  const shared = titleTokens.filter((token) => candidateTokens.has(token)).length;
  return shared / titleTokens.length;
}

function mostAppropriateBug(issueTitle, fullText, bugs, actualResult = "") {
  const scored = bugs.map((bug) => {
    const referenceEvidence = [
      bug.title,
      bug.discussion,
      bug.updated,
      bug.severityReasoning,
      bug.conclusion
    ].join(" ");
    const titleScore = Math.max(
      titleSimilarity(issueTitle, bug.title),
      actualResult ? titleTokenCoverage(actualResult, referenceEvidence) : 0
    );
    const contextScore = scoreText(fullText, [
      bug.title, bug.reportedWcag, bug.discussion,
      bug.updated, bug.severityReasoning, bug.conclusion
    ].join(" "));
    // Title match is weighted 3× so a close title dominates
    return { bug, titleScore, score: titleScore * 3 + contextScore };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

// Returns the reference bugs most relevant to an issue, ranked with the same
// title/context scoring used by mostAppropriateBug. Used to keep the Copilot
// prompt small: only a shortlist of candidate references is sent to the model,
// which then picks the single best match (or none).
export function shortlistReferences(input, dataset, limit = 15) {
  const actualResult = String(input.actualResult || "").trim()
    || extractIssueSection(input.body, "Actual Result");
  const combined = [
    input.title,
    input.body,
    actualResult,
    input.expectedResult,
    input.codeSnippet,
    input.citedWcag
  ].filter(Boolean).join(" ");
  return dataset.bugs.map((bug) => {
    const referenceEvidence = [
      bug.title, bug.discussion, bug.updated, bug.severityReasoning, bug.conclusion
    ].filter(Boolean).join(" ");
    const titleScore = Math.max(
      titleSimilarity(input.title, bug.title),
      actualResult ? titleTokenCoverage(actualResult, referenceEvidence) : 0
    );
    const contextScore = scoreText(combined, [
      bug.title, bug.reportedWcag, bug.discussion,
      bug.updated, bug.severityReasoning, bug.conclusion
    ].join(" "));
    return { bug, score: titleScore * 3 + contextScore };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.bug);
}

function suggestionsFromUpdatedColumn(reference) {
  if (!reference?.updated) return { wcag: null, severity: "" };
  const wcagIds = extractWcag(reference.updated);
  const severity = extractSeverity(reference.updated);
  return {
    wcag: wcagIds[0] || null,
    severity
  };
}

function validityFromReference(reference) {
  if (!reference) return "";
  const outcome = normalize(`${reference.updated} ${reference.conclusion}`);
  if (/(not a bug|not an issue|false positive|by design|expected behavior|expected behaviour)/.test(outcome)) {
    return "Invalid";
  }
  if (/(valid issue|valid bug|agrees it.s a bug|wcag [1-4]\.)/.test(outcome)) {
    return "Valid";
  }
  if (/(usable|usability|sev-4)/.test(outcome)) {
    return "Valid as a usability issue, not a WCAG failure";
  }
  return "";
}

function invalidityFromText(text) {
  const value = normalize(text);
  if (/(false positive|not a bug|not an issue|works as designed|working as designed|this is expected behavior|this is expected behaviour|behavior is expected|behaviour is expected)/.test(value)) {
    return "The available issue evidence indicates expected behavior, a false positive, or no accessibility failure.";
  }
  return "";
}

function grammarSuggestions(text) {
  const source = String(text || "");
  const suggestions = [];
  const seen = new Set();

  for (const word of source.match(/\b[\p{L}']+\b/gu) || []) {
    const replacement = TYPO_FIXES.get(word.toLowerCase());
    if (replacement && !seen.has(word.toLowerCase())) {
      suggestions.push(`Replace "${word}" with "${replacement}".`);
      seen.add(word.toLowerCase());
    }
  }

  const rules = [
    [/\bdoes not\s+([a-z]+)s\b/i, "After “does not,” use the base verb (for example, “does not announce”)."],
    [/\bis the issue is\b/i, "Use “Is the issue valid or invalid?”"],
    [/\bscreen reader does not (?:announces|reads)\b/i, "Use a base verb after “does not”: “announce” or “read.”"],
    [/\buser are\b/i, "Use “user is” or “users are,” depending on meaning."],
    [/\bthere is (?:many|several)\b/i, "Use “there are” with plural nouns."],
    [/[ \t]{2,}/, "Remove repeated spaces."],
    [/[.!?]\s*[a-z]/, "Start each sentence with a capital letter."]
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(source)) suggestions.push(message);
  }
  if (source.trim() && !/[.!?]$/.test(source.trim())) {
    suggestions.push("Add ending punctuation.");
  }
  return [...new Set(suggestions)].slice(0, 8);
}

export function reviewIssue(input, dataset) {
  const combined = [
    input.title,
    input.body,
    input.citedWcag,
    input.alternateSeverityReasoning,
    input.labels?.join(" ")
  ].join(" ");
  const exactReference = dataset.bugs.find(
    (bug) => String(bug.id) === String(input.bugId).replace(/^#/, "")
  );
  const citedIds = extractWcag(`${input.citedWcag} ${combined}`);
  const isCitedFocusOrder = citedIds.includes("2.4.3");
  // Actual Result text is used for matching on every review, not just Focus Order citations,
  // so the title + Actual Result together give a more accurate reference/WCAG match.
  const actualResult = String(input.actualResult || "").trim()
    || extractIssueSection(input.body, "Actual Result");
  const matchedReference = mostAppropriateBug(
    input.title,
    combined,
    dataset.bugs,
    actualResult
  );
  const topReference = exactReference || matchedReference?.bug || null;
  // Compute title overlap for whichever reference was selected
  const refTitleScore = topReference
    ? (exactReference
      ? Math.max(
        titleSimilarity(input.title, exactReference.title),
        actualResult
          ? titleTokenCoverage(actualResult, [
            exactReference.title,
            exactReference.discussion,
            exactReference.updated,
            exactReference.severityReasoning,
            exactReference.conclusion
          ].join(" "))
          : 0
      )
      : (matchedReference?.titleScore || 0))
    : 0;
  // Score reference bug Updated column
  const refSuggestions = suggestionsFromUpdatedColumn(topReference);
  // Only surface the reference bug in the output when the title-token overlap is
  // strong enough (>40%) to be considered a reliable match.
  const referenceQualifies = refTitleScore > 0.4;
  const visibleReference = referenceQualifies ? topReference : null;
  const refWcagCriterion = refSuggestions.wcag
    ? findCriterion(dataset, refSuggestions.wcag)
    : null;
  // Score WCAG guidance documents
  const guidanceCriterion = suggestWcagFromDocs(
    input.title,
    combined,
    dataset,
    actualResult
  );
  // Valid suggestions require a strong title-token match (>40%) from either source.
  let suggestedCriterion;
  let suggestionSource;
  const strongReferenceMatch = Boolean(refWcagCriterion) && refTitleScore > 0.4;
  const strongGuidanceMatch = Boolean(guidanceCriterion.criterion)
    && guidanceCriterion.titleOverlap > 0.4;
  const referenceCrossValidated = strongReferenceMatch
    && strongGuidanceMatch
    && refWcagCriterion.id === guidanceCriterion.criterion.id;
  let selectedOverlap = 0;
  if (referenceCrossValidated) {
    suggestedCriterion = refWcagCriterion;
    suggestionSource = "reference";
    selectedOverlap = Math.min(refTitleScore, guidanceCriterion.titleOverlap);
  } else if (strongGuidanceMatch && !strongReferenceMatch) {
    suggestedCriterion = guidanceCriterion.criterion;
    suggestionSource = "wcag-docs";
    selectedOverlap = guidanceCriterion.titleOverlap;
  } else if (strongReferenceMatch && strongGuidanceMatch) {
    if (refTitleScore >= guidanceCriterion.titleOverlap) {
      suggestedCriterion = refWcagCriterion;
      suggestionSource = "reference";
      selectedOverlap = refTitleScore;
    } else {
      suggestedCriterion = guidanceCriterion.criterion;
      suggestionSource = "wcag-docs";
      selectedOverlap = guidanceCriterion.titleOverlap;
    }
  } else if (refWcagCriterion
      && (!guidanceCriterion.criterion
        || refTitleScore >= guidanceCriterion.titleOverlap)) {
    suggestedCriterion = refWcagCriterion;
    suggestionSource = "reference";
    selectedOverlap = refTitleScore;
  } else if (guidanceCriterion.criterion) {
    suggestedCriterion = guidanceCriterion.criterion;
    suggestionSource = "wcag-docs";
    selectedOverlap = guidanceCriterion.titleOverlap;
  } else {
    suggestedCriterion = null;
    suggestionSource = "none";
  }
  // Guard against 4.1.3 Status Messages being suggested purely from generic word overlap
  // (e.g. "announces incorrect/unnecessary information") when the issue text has none of the
  // concrete status-message/live-region indicators. Bugs about a field or control announcing
  // wrong/extra static information are normally WCAG 1.3.1 Info and Relationships, not 4.1.3.
  const genuineStatusMessagePattern = /(status message|live region|aria-live|toast|success message|error message (?:displayed|shown)|dynamically updated|search result|no results found|results found)/i;
  if (suggestedCriterion?.id === "4.1.3" && !genuineStatusMessagePattern.test(combined)) {
    const fallbackCriterion = findCriterion(dataset, "1.3.1");
    if (fallbackCriterion) {
      suggestedCriterion = fallbackCriterion;
      suggestionSource = "wcag-docs";
    }
  }
  const citedCriteria = citedIds.map((id) => findCriterion(dataset, id)).filter(Boolean);
  const citedSeverity = extractSeverity(
    `${input.citedSeverity || ""} ${(input.labels || []).join(" ")}`
  );
  const referenceSeverity = suggestionSource === "reference"
    ? (refSuggestions.severity
      || extractSeverity(topReference?.updated || topReference?.reportedSeverity))
    : "";
  const referenceValidity = validityFromReference(topReference);
  const textInvalidity = invalidityFromText(`${input.title} ${input.body}`);
  const hasReproduction = /(steps? to reproduce|actual result|expected result|reproduc)/i.test(combined);
  // Only mark invalid if the reference title match is strong (>60% token overlap)
  const refTitleStrong = refTitleScore > 0.6;
  // Guard against templated bug titles (e.g. "'Footnote 5' links are not descriptive enough")
  // that look like an exact title match to an unrelated "Not a Bug" reference purely because
  // numbers/element names are stripped out during tokenization. When independent WCAG guidance
  // strongly supports a real criterion for this issue, don't let that coincidental title
  // collision silently blank out the WCAG suggestion. This only applies to a heuristically
  // matched reference (not an exact bug-ID match, which is an authoritative prior conclusion).
  const guidanceConflictsWithInvalidReference = !exactReference
    && referenceValidity === "Invalid"
    && strongGuidanceMatch;
  const confirmedInvalid = referenceValidity === "Invalid" && refTitleStrong && !guidanceConflictsWithInvalidReference;
  const confirmedTextInvalid = textInvalidity && refTitleStrong;
  const validity = (confirmedInvalid ? "Invalid" : "")
    || (confirmedTextInvalid ? "Invalid" : "")
    || (referenceValidity === "Invalid" && (!refTitleStrong || guidanceConflictsWithInvalidReference)
      ? "Likely invalid (weak reference match)" : "")
    || referenceValidity
    || (textInvalidity && !refTitleStrong ? "Needs review — possible invalid" : "")
    || (combined.trim().length < 60 || !hasReproduction
      ? "Needs more information"
      : suggestedCriterion ? "Likely valid" : "Likely usability issue");
  const isInvalid = validity === "Invalid";
  const reasoningSeverity = input.alternateSeverityReasoning
    ? analyzeAlternateSeverity(input.alternateSeverityReasoning, combined, Boolean(suggestedCriterion))
    : "";
  const hasStrongValidMatch = selectedOverlap > 0.4;
  const suggestedSeverity = isInvalid || !suggestedCriterion
    ? ""
    : referenceSeverity
      || reasoningSeverity
      || suggestSeverity(combined, Boolean(suggestedCriterion));
  const feedback = [];

  if (isInvalid) {
    const justification = topReference?.conclusion
      || topReference?.discussion
      || textInvalidity
      || "The available evidence does not demonstrate an accessibility failure.";
    const referencePrefix = visibleReference ? `Reference #${visibleReference.id}: ` : "";
    return {
      validity,
      citedWcag: "",
      suggestedWcag: "",
      citedSeverity: "",
      suggestedSeverity: "",
      reference: visibleReference,
      feedback: `Invalid bug justification: ${referencePrefix}${justification}`
    };
  }

  const manualCheckRequired = !hasStrongValidMatch && Boolean(suggestedCriterion);
  if (!hasReproduction) {
    feedback.push("Add clear steps to reproduce, actual result, expected result, environment, and assistive technology details.");
  }
  if (guidanceConflictsWithInvalidReference) {
    feedback.push(`MANUAL CHECK REQUIRED: A reference bug with a similar title was closed as invalid, but WCAG guidance independently supports ${guidanceCriterion.criterion.id} for this issue. Confirm which situation actually applies before dismissing it.`);
  }
  if (manualCheckRequired) {
    feedback.push("MANUAL CHECK REQUIRED: The best available WCAG and severity are shown, but the selected title-token overlap is below 40%. Confirm them against the complete issue, Actual Result, and reproduction evidence.");
  }
  if (strongReferenceMatch && strongGuidanceMatch
      && refWcagCriterion?.id !== guidanceCriterion.criterion?.id) {
    feedback.push("The reference bug and WCAG guidance produced different criteria; the source with the higher title-token overlap was selected.");
  }
  if (isCitedFocusOrder) {
    if (!actualResult) {
      feedback.push("WCAG 2.4.3 was cited, but no identifiable Actual Result section was found. Add or clearly label the Actual Result for a reliable comparison.");
    }
  }
  if (!citedIds.length) {
    feedback.push("No WCAG success criterion was detected; confirm the suggested criterion through manual testing.");
  } else if (suggestedCriterion && citedIds[0] !== suggestedCriterion.id) {
    feedback.push(`Re-check the cited WCAG criterion; ${suggestedCriterion.id} appears more closely aligned with the reported behavior.`);
  }
  if (citedSeverity && citedSeverity !== suggestedSeverity) {
    feedback.push(`Reassess severity using user impact and workaround availability; the guidance indicates ${suggestedSeverity}.`);
  }
  if (input.alternateSeverityReasoning && !manualCheckRequired) {
    feedback.push(`Alternate Severity Reasoning analyzed: ${stripTrailingSections(input.alternateSeverityReasoning)}`);
  }
  if (visibleReference) {
    const parts = [`Reference #${visibleReference.id}`];
    if (visibleReference.updated) parts.push(`Updated WCAG/Severity: ${visibleReference.updated}`);
    feedback.push(parts.join(" — "));
  }
  if (!manualCheckRequired) {
    if (suggestionSource === "wcag-docs") {
      feedback.push(`Suggested WCAG is based on title matching against the provided WCAG guidance documents.`);
    } else if (suggestionSource === "reference") {
      feedback.push(`Suggested WCAG is based on the most appropriate reference bug's Updated WCAG/Severity column.`);
    }
  }
  return {
    validity,
    citedWcag: citedCriteria.length
      ? `${citedCriteria[0].id} ${citedCriteria[0].title}`
      : input.citedWcag || "Not provided",
    suggestedWcag: suggestedCriterion
      ? `${suggestedCriterion.id} ${suggestedCriterion.title}`
      : "No confident WCAG suggestion available",
    citedSeverity: citedSeverity || "No Severity-1 to Severity-4 label found",
    suggestedSeverity,
    reference: visibleReference,
    feedback: feedback.length ? feedback.join("\n") : "No modification suggested from the available local guidance."
  };
}

export const reviewerInternals = {
  analyzeAlternateSeverity,
  extractSeverity,
  extractIssueSection,
  extractWcag,
  grammarSuggestions,
  suggestSeverity,
  titleSimilarity,
  titleTokenCoverage,
  suggestionsFromUpdatedColumn,
  stripTrailingSections
};
