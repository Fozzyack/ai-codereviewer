import minimatch from "minimatch";
import { Chunk, File } from "parse-diff";

import { AIReview, ReviewComment } from "../types";

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

export function createComment(
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

export function filterDiffByExclude(
  parsedDiff: File[],
  excludeInput: string
): File[] {
  const excludePatterns = excludeInput
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });
}
