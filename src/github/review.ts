import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

import { EventData, PRDetails, ReviewComment } from "../types";

export async function getPRDetails(
  octokit: Octokit,
  eventData: EventData
): Promise<PRDetails> {
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

export async function getDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

export async function getSynchronizeDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<string> {
  const response = await octokit.repos.compareCommits({
    headers: {
      accept: "application/vnd.github.v3.diff",
    },
    owner,
    repo,
    base,
    head,
  });

  return String(response.data);
}

export async function hasExistingSummaryReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  summaryMarker: string
): Promise<boolean> {
  let page = 1;

  while (true) {
    const response = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });

    const hasSummary = response.data.some((review) => {
      const body = review.body || "";
      return (
        body.includes(summaryMarker) ||
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

export async function createReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
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
    pull_number: pullNumber,
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
        pull_number: pullNumber,
        event: "COMMENT",
        body: reviewPayload.body,
      });
      return;
    }
    throw error;
  }
}
