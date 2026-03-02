import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  return {
    getInput: vi.fn((name: string) => ""),
    info: vi.fn(),
    warning: vi.fn(),
    createReview: vi.fn(),
    createCompletion: vi.fn(),
  };
});

vi.mock("@actions/core", () => ({
  getInput: mockState.getInput,
  info: mockState.info,
  warning: mockState.warning,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    pulls = {
      get: vi.fn(),
      createReview: mockState.createReview,
    };

    repos = {
      compareCommits: vi.fn(),
    };
  },
}));

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: mockState.createCompletion,
      },
    };
  },
}));

import {
  createComment,
  createPrompt,
  createReviewComment,
  createSummaryPrompt,
  filterDiffByExclude,
  getAIResponse,
  getCommentableLines,
  parseAIReviewsContent,
} from "../../src/main";

describe("main helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.getInput.mockImplementation((name: string) => {
      if (name === "OPENAI_API_MODEL") {
        return "gpt-4-1106-preview";
      }
      return "test-value";
    });
  });

  it("collects only ln2 commentable lines", () => {
    const chunk = {
      changes: [
        { type: "normal", ln2: 10 },
        { type: "del", ln: 11 },
        { type: "add", ln: 12 },
        { type: "normal", ln2: 13 },
      ],
    } as any;

    expect(Array.from(getCommentableLines(chunk))).toEqual([10, 13]);
  });

  it("builds prompt with sorted allowed lines and PR context", () => {
    const chunk = {
      content: "@@ -1,2 +1,3 @@",
      changes: [
        { type: "normal", ln2: 6, content: " line one" },
        { type: "normal", ln2: 4, content: " line two" },
      ],
    } as any;

    const prompt = createPrompt({ to: "src/foo.ts" } as any, chunk, {
      owner: "octo-org",
      repo: "ai-codereviewer",
      pull_number: 1,
      title: "Improve parser",
      description: "Adds stricter parsing",
    });

    expect(prompt).toContain(
      "Only use line numbers that are in this list: [4, 6]"
    );
    expect(prompt).toContain('file "src/foo.ts"');
    expect(prompt).toContain("Pull request title: Improve parser");
  });

  it("builds truncated summary prompt", () => {
    const veryLong = "x".repeat(13000);
    const prompt = createSummaryPrompt(
      [{ to: "src/huge.ts", chunks: [{ content: veryLong }] }] as any,
      {
        owner: "o",
        repo: "r",
        pull_number: 1,
        title: "Long change",
        description: "desc",
      }
    );

    expect(prompt).toContain("truncated to 12000 chars");
    expect(prompt).toContain("Pull request title: Long change");
  });

  it("parses and filters AI reviews", () => {
    const reviews = parseAIReviewsContent(
      JSON.stringify({
        reviews: [
          { lineNumber: 2, reviewComment: "good catch" },
          { lineNumber: 0, reviewComment: "bad" },
          { lineNumber: "abc", reviewComment: "bad" },
          { lineNumber: 3, reviewComment: "   " },
        ],
      })
    );

    expect(reviews).toEqual([{ lineNumber: 2, reviewComment: "good catch" }]);
  });

  it("maps comments and strips b/ prefix", () => {
    const comments = createComment(
      { to: "b/src/foo.ts" } as any,
      {
        changes: [
          { type: "normal", ln2: 7 },
          { type: "normal", ln2: 8 },
        ],
      } as any,
      [
        { lineNumber: 8, reviewComment: "looks risky" },
        { lineNumber: 999, reviewComment: "invalid" },
      ]
    );

    expect(comments).toEqual([
      {
        body: "looks risky",
        path: "src/foo.ts",
        line: 8,
      },
    ]);
  });

  it("filters diff files by exclude patterns", () => {
    const filtered = filterDiffByExclude(
      [
        { to: "src/foo.ts" },
        { to: "README.md" },
        { to: "dist/index.js" },
      ] as any,
      " **/*.md , dist/** "
    );

    expect(filtered).toEqual([{ to: "src/foo.ts" }]);
  });

  it("returns null when AI response JSON is invalid", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockState.createCompletion.mockResolvedValue({
      choices: [{ message: { content: "not-json" } }],
    });

    const result = await getAIResponse("prompt");

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("retries summary-only payload on 422", async () => {
    mockState.createReview
      .mockRejectedValueOnce({ status: 422 })
      .mockResolvedValueOnce({});

    await createReviewComment(
      "o",
      "r",
      1,
      [{ body: "x", path: "a.ts", line: 2 }],
      "sum"
    );

    expect(mockState.createReview).toHaveBeenCalledTimes(2);
    expect(mockState.createReview.mock.calls[1][0]).toEqual({
      owner: "o",
      repo: "r",
      pull_number: 1,
      event: "COMMENT",
      body: "sum",
    });
    expect(mockState.warning).toHaveBeenCalledTimes(1);
  });

  it("logs and skips createReview when payload is empty", async () => {
    await createReviewComment("o", "r", 1, [], undefined);

    expect(mockState.createReview).not.toHaveBeenCalled();
    expect(mockState.info).toHaveBeenCalledWith(
      "No summary or inline comments to post."
    );
  });

  it("rethrows non-422 review errors", async () => {
    const err = { status: 500 };
    mockState.createReview.mockRejectedValueOnce(err);

    await expect(
      createReviewComment(
        "o",
        "r",
        1,
        [{ body: "x", path: "a.ts", line: 2 }],
        "sum"
      )
    ).rejects.toEqual(err);
  });
});
