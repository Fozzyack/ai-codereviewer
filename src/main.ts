import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

function getRequiredInput(name: string): string {
  return core.getInput(name, { required: true }).trim();
}

function getOptionalInput(name: string, fallback: string): string {
  const input = core.getInput(name).trim();
  return input || fallback;
}

function getBoundedIntInput(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const input = core.getInput(name).trim();
  if (!input) {
    return fallback;
  }
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    core.warning(
      `${name} must be an integer between ${min} and ${max}. Falling back to ${fallback}.`
    );
    return fallback;
  }
  if (parsed < min) {
    core.warning(`${name} must be at least ${min}. Using ${min}.`);
    return min;
  }
  if (parsed > max) {
    core.warning(`${name} must be at most ${max}. Using ${max}.`);
    return max;
  }
  return parsed;
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const GITHUB_TOKEN: string = getRequiredInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = getRequiredInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = getOptionalInput("OPENAI_API_MODEL", "gpt-4");
const INCLUDE_FIX_PROMPT: boolean =
  core.getInput("include_fix_prompt").trim().toLowerCase() !== "false";
const SUMMARY_ONCE: boolean =
  core.getInput("summary_once").trim().toLowerCase() !== "false";
const FIX_PROMPT_MAX_ITEMS: number = getBoundedIntInput(
  "fix_prompt_max_items",
  20,
  1,
  200
);
const SUMMARY_MARKER = "<!-- ai-code-reviewer-summary -->";

if (!MODEL_ID_PATTERN.test(OPENAI_API_MODEL)) {
  throw new Error(
    "OPENAI_API_MODEL contains invalid characters. Use letters, numbers, '.', '_', '-', or ':'."
  );
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface AIReview {
  lineNumber: number;
  reviewComment: string;
}

interface ReviewComment {
  body: string;
  path: string;
  line: number;
}

interface EventData {
  action: string;
  before?: string;
  after?: string;
  number: number;
  repository: {
    owner: {
      login: string;
    };
    name: string;
  };
}

function getRequiredEventPath(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is not set");
  }
  return eventPath;
}

function getEventData(): EventData {
  const eventRaw = readFileSync(getRequiredEventPath(), "utf8");
  const eventData = JSON.parse(eventRaw) as Partial<EventData>;

  if (
    !eventData.repository?.owner?.login ||
    !eventData.repository?.name ||
    typeof eventData.number !== "number" ||
    !eventData.action
  ) {
    throw new Error(
      "GitHub event payload is missing required pull request fields"
    );
  }

  return eventData as EventData;
}

async function getPRDetails(eventData: EventData): Promise<PRDetails> {
  const { repository, number } = eventData;
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function getCommentableLines(chunk: Chunk): Set<number> {
  const lines = new Set<number>();
  for (const change of chunk.changes) {
    if (change.type === "del") continue;
    // @ts-expect-error - ln2 exists on non-deleted changes
    if (typeof change.ln2 === "number") {
      // @ts-expect-error - ln2 exists on non-deleted changes
      lines.add(change.ln2);
    }
  }
  return lines;
}

function createSummaryPrompt(parsedDiff: File[], prDetails: PRDetails): string {
  const MAX_DIFF_CHARS = 12000;

  const summarizedDiff = parsedDiff
    .map((file) => {
      const chunkPreview = file.chunks
        .slice(0, 3)
        .map((chunk) => chunk.content)
        .join("\n");
      return `File: ${file.to}\n${chunkPreview}`;
    })
    .join("\n\n")
    .slice(0, MAX_DIFF_CHARS);

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

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
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
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: number;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(res);
    const rawReviews: unknown[] = Array.isArray(parsed.reviews)
      ? parsed.reviews
      : [];

    return rawReviews
      .map((review: unknown) => {
        const typedReview = review as Partial<AIReview>;
        const lineNumber = Number(typedReview.lineNumber);
        const reviewComment =
          typeof typedReview.reviewComment === "string"
            ? typedReview.reviewComment
            : "";
        if (
          !Number.isFinite(lineNumber) ||
          lineNumber <= 0 ||
          !reviewComment.trim()
        ) {
          return null;
        }
        return {
          lineNumber,
          reviewComment,
        };
      })
      .filter((review): review is AIReview => review !== null);
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

async function getAISummary(prompt: string): Promise<string | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 400,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const summary = response.choices[0]?.message?.content?.trim();
    return summary || null;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: AIReview[]
): ReviewComment[] {
  const validLines = getCommentableLines(chunk);

  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    if (!validLines.has(aiResponse.lineNumber)) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to.replace(/^b\//, ""),
      line: Number(aiResponse.lineNumber),
    };
  });
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

function createFixPromptSection(
  comments: ReviewComment[],
  prDetails: PRDetails
): string | null {
  const uniqueIssues = getUniqueIssues(comments).slice(0, FIX_PROMPT_MAX_ITEMS);

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

function buildReviewBody(
  summary: string | null,
  fixPromptSection: string | null
) {
  const sections = [summary, fixPromptSection]
    .filter((section): section is string => Boolean(section && section.trim()))
    .map((section) => section.trim());

  if (sections.length === 0) {
    return undefined;
  }

  return `${sections.join("\n\n")}\n\n${SUMMARY_MARKER}`;
}

async function hasExistingSummaryReview(
  owner: string,
  repo: string,
  pull_number: number
): Promise<boolean> {
  let page = 1;

  while (true) {
    const response = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number,
      per_page: 100,
      page,
    });

    const hasSummary = response.data.some((review) => {
      const body = review.body || "";
      return (
        body.includes(SUMMARY_MARKER) ||
        body.includes("## Fix Prompt") ||
        body.includes("### Summary of Pull Request Review")
      );
    });

    if (hasSummary) {
      return true;
    }

    if (response.data.length < 100) {
      return false;
    }

    page += 1;
  }
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: ReviewComment[],
  summaryBody?: string
): Promise<void> {
  const reviewPayload: {
    owner: string;
    repo: string;
    pull_number: number;
    event: "COMMENT";
    comments?: Array<{ body: string; path: string; line: number }>;
    body?: string;
  } = {
    owner,
    repo,
    pull_number,
    event: "COMMENT",
  };

  if (comments.length > 0) {
    reviewPayload.comments = comments;
  }

  if (summaryBody) {
    reviewPayload.body = summaryBody;
  }

  if (!reviewPayload.comments && !reviewPayload.body) {
    core.info("No summary or inline comments to post.");
    return;
  }

  try {
    await octokit.pulls.createReview(reviewPayload);
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status === 422 && reviewPayload.body) {
      core.warning(
        "Some inline comments could not be resolved. Retrying with summary only."
      );
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        event: "COMMENT",
        body: reviewPayload.body,
      });
      return;
    }
    throw error;
  }
}

async function main() {
  const eventData = getEventData();
  const prDetails = await getPRDetails(eventData);
  let diff: string | null;

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    if (!newBaseSha || !newHeadSha) {
      throw new Error("Missing before/after SHAs for synchronize event");
    }

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  const shouldIncludeSummary = SUMMARY_ONCE
    ? !(await hasExistingSummaryReview(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      ))
    : true;

  const summary = shouldIncludeSummary
    ? await getAISummary(createSummaryPrompt(filteredDiff, prDetails))
    : null;
  const fixPromptSection =
    shouldIncludeSummary && INCLUDE_FIX_PROMPT
      ? createFixPromptSection(comments, prDetails)
      : null;
  const reviewBody = buildReviewBody(summary, fixPromptSection);

  await createReviewComment(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number,
    comments,
    reviewBody
  );
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
