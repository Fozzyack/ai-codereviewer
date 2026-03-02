import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

export interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

export interface AIReview {
  lineNumber: number;
  reviewComment: string;
}

export function getRequiredEventPath(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is not set");
  }
  return eventPath;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(getRequiredEventPath(), "utf8")
  );
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
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

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

export function getCommentableLines(chunk: Chunk): Set<number> {
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

export function createSummaryPrompt(
  parsedDiff: File[],
  prDetails: PRDetails
): string {
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
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

export function parseAIReviewsContent(content: string): AIReview[] {
  const parsed = JSON.parse(content);
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
}

export async function getAIResponse(prompt: string): Promise<Array<{
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
    return parseAIReviewsContent(res);
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

export function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: AIReview[]
): Array<{ body: string; path: string; line: number }> {
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

export async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>,
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

export function filterDiffByExclude(
  parsedDiff: File[],
  excludeInput: string
): File[] {
  const excludePatterns = excludeInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });
}

export async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(readFileSync(getRequiredEventPath(), "utf8"));

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

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

  const filteredDiff = filterDiffByExclude(
    parsedDiff,
    core.getInput("exclude")
  );

  const comments = await analyzeCode(filteredDiff, prDetails);
  const summaryPrompt = createSummaryPrompt(filteredDiff, prDetails);
  const summary = await getAISummary(summaryPrompt);

  await createReviewComment(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number,
    comments,
    summary || undefined
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
