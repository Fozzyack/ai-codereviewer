import { File } from "parse-diff";

import { AIReview, PRDetails, ReviewComment } from "../types";
import { createComment } from "./diff";
import { createPrompt } from "./prompts";

export async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
  getAIResponse: (prompt: string) => Promise<AIReview[] | null>
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (!aiResponse) {
        continue;
      }

      const newComments = createComment(file, chunk, aiResponse);
      if (newComments.length > 0) {
        comments.push(...newComments);
      }
    }
  }

  return comments;
}
