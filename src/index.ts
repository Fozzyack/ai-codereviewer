import { Octokit } from "@octokit/rest";
import OpenAI from "openai";
import parseDiff, { Chunk, File } from "parse-diff";

import { loadRuntimeConfig } from "./config/inputs";
import { getEventData, getRequiredEventPath } from "./github/event";
import {
  createReviewComment as createReviewCommentWithClient,
  getDiff,
  getPRDetails,
  getSynchronizeDiff,
  hasExistingSummaryReview,
} from "./github/review";
import {
  getAIResponse as getAIResponseWithClient,
  getAISummary,
  parseAIReviewsContent,
} from "./openai/review";
import { analyzeCode } from "./review/analyze";
import {
  createComment,
  filterDiffByExclude,
  getCommentableLines,
} from "./review/diff";
import {
  buildReviewBody,
  createFixPromptSection,
  createPrompt,
  createSummaryPrompt,
} from "./review/prompts";
import { AIReview, PRDetails, ReviewComment } from "./types";

const SUMMARY_MARKER = "<!-- ai-code-reviewer-summary -->";

const runtimeConfig = loadRuntimeConfig();
const octokit = new Octokit({ auth: runtimeConfig.githubToken });
const openai = new OpenAI({ apiKey: runtimeConfig.openAiApiKey });

export {
  getRequiredEventPath,
  createPrompt,
  createSummaryPrompt,
  parseAIReviewsContent,
};
export type { AIReview, PRDetails };

export function getCommentableLinesForChunk(chunk: Chunk): Set<number> {
  return getCommentableLines(chunk);
}

export { getCommentableLinesForChunk as getCommentableLines };

export function createCommentForChunk(
  file: File,
  chunk: Chunk,
  aiResponses: AIReview[]
): ReviewComment[] {
  return createComment(file, chunk, aiResponses);
}

export { createCommentForChunk as createComment, filterDiffByExclude };

export async function getAIResponse(
  prompt: string
): Promise<AIReview[] | null> {
  return getAIResponseWithClient(openai, runtimeConfig.openAiApiModel, prompt);
}

export async function createReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  comments: ReviewComment[],
  summaryBody?: string
): Promise<void> {
  return createReviewCommentWithClient(
    octokit,
    owner,
    repo,
    pullNumber,
    comments,
    summaryBody
  );
}

export async function main() {
  const eventData = getEventData();
  const prDetails = await getPRDetails(octokit, eventData);

  let diff: string | null;
  if (eventData.action === "opened") {
    diff = await getDiff(
      octokit,
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

    diff = await getSynchronizeDiff(
      octokit,
      prDetails.owner,
      prDetails.repo,
      newBaseSha,
      newHeadSha
    );
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
    runtimeConfig.excludeInput
  );

  const comments = await analyzeCode(filteredDiff, prDetails, getAIResponse);

  const shouldIncludeSummary = runtimeConfig.summaryOnce
    ? !(await hasExistingSummaryReview(
        octokit,
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        SUMMARY_MARKER
      ))
    : true;

  const summary = shouldIncludeSummary
    ? await getAISummary(
        openai,
        runtimeConfig.openAiApiModel,
        createSummaryPrompt(filteredDiff, prDetails)
      )
    : null;

  const fixPromptSection =
    shouldIncludeSummary && runtimeConfig.includeFixPrompt
      ? createFixPromptSection(
          comments,
          prDetails,
          runtimeConfig.fixPromptMaxItems
        )
      : null;

  const reviewBody = buildReviewBody(summary, fixPromptSection, SUMMARY_MARKER);

  await createReviewComment(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number,
    comments,
    reviewBody
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
