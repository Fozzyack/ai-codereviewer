import { Chunk, File } from "parse-diff";

import { PRDetails, ReviewComment } from "../types";
import { getCommentableLines } from "./diff";

export function createSummaryPrompt(
  parsedDiff: File[],
  prDetails: PRDetails
): string {
  const maxDiffChars = 12000;

  const summarizedDiff = parsedDiff
    .map((file) => {
      const chunkPreview = file.chunks
        .slice(0, 3)
        .map((chunk) => chunk.content)
        .join("\n");
      return `File: ${file.to}\n${chunkPreview}`;
    })
    .join("\n\n")
    .slice(0, maxDiffChars);

  const usedChars = summarizedDiff.length;

  return `You are reviewing a pull request. Provide a concise GitHub Markdown summary.

Instructions:
- Focus on the overall impact, key risks, and recommended follow-up checks.
- If there are no major concerns, explicitly say that no critical issues were found.
- Do not provide compliments or mention writing code comments.
- Keep it short: 3 to 6 bullet points.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Changed files and diff excerpts (truncated to ${usedChars} chars):

\`\`\`diff
${summarizedDiff}
\`\`\``;
}

export function createPrompt(
  file: File,
  chunk: Chunk,
  prDetails: PRDetails
): string {
  const commentableLines = Array.from(getCommentableLines(chunk)).sort(
    (a, b) => a - b
  );

  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- Only use line numbers that are in this list: [${commentableLines.join(", ")}]

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((change) => `${change.ln ? change.ln : change.ln2} ${change.content}`)
  .join("\n")}
\`\`\`
`;
}

function normalizeIssueText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeForCodeBlock(text: string): string {
  return text.replace(/```/g, "'''");
}

function getUniqueIssues(comments: ReviewComment[]): ReviewComment[] {
  const seen = new Set<string>();
  const issues: ReviewComment[] = [];

  for (const comment of comments) {
    const normalizedBody = normalizeIssueText(comment.body).toLowerCase();
    const issueKey = `${comment.path}:${comment.line}:${normalizedBody}`;
    if (seen.has(issueKey)) {
      continue;
    }

    seen.add(issueKey);
    issues.push({
      ...comment,
      body: normalizeIssueText(comment.body),
    });
  }

  return issues;
}

export function createFixPromptSection(
  comments: ReviewComment[],
  prDetails: PRDetails,
  maxItems: number
): string | null {
  const uniqueIssues = getUniqueIssues(comments).slice(0, maxItems);

  if (uniqueIssues.length === 0) {
    return null;
  }

  const issueList = uniqueIssues
    .map((issue, index) => {
      const truncatedBody =
        issue.body.length > 400
          ? `${issue.body.slice(0, 397).trimEnd()}...`
          : issue.body;
      return `${index + 1}. ${issue.path}:${
        issue.line
      } - ${sanitizeForCodeBlock(truncatedBody)}`;
    })
    .join("\n");

  const prDescription =
    sanitizeForCodeBlock(prDetails.description.trim()) ||
    "(no description provided)";
  const fixPrompt = `You are an AI coding agent. Fix the issues listed below for this pull request.

Pull request title: ${sanitizeForCodeBlock(prDetails.title)}
Pull request description:
${prDescription}

Issues to fix:
${issueList}

Constraints:
- Make the smallest safe set of changes needed to resolve the issues.
- Preserve existing behavior unless an issue explicitly requires a behavior change.
- Update or add tests when needed to cover the fix.
- Run project checks (lint/build/tests) and ensure they pass.

Return:
- A short summary of what you changed.
- The list of files modified.
- Any follow-up work that remains.`;

  return `## Fix Prompt

Use this prompt with your coding agent to address the detected issues:

\`\`\`text
${fixPrompt}
\`\`\``;
}

export function buildReviewBody(
  summary: string | null,
  fixPromptSection: string | null,
  summaryMarker: string
): string | undefined {
  const sections = [summary, fixPromptSection]
    .filter((section): section is string => Boolean(section && section.trim()))
    .map((section) => section.trim());

  if (sections.length === 0) {
    return undefined;
  }

  return `${sections.join("\n\n")}\n\n${summaryMarker}`;
}
