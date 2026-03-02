import OpenAI from "openai";

import { AIReview } from "../types";

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

export async function getAIResponse(
  openai: OpenAI,
  openAiApiModel: string,
  prompt: string
): Promise<AIReview[] | null> {
  const queryConfig = {
    model: openAiApiModel,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      ...(openAiApiModel === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" as const } }
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

export async function getAISummary(
  openai: OpenAI,
  openAiApiModel: string,
  prompt: string
): Promise<string | null> {
  const queryConfig = {
    model: openAiApiModel,
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
