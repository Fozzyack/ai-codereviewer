import { beforeEach, describe, expect, it, vi } from "vitest";

const OPENED_EVENT_FIXTURE = JSON.stringify({
  action: "opened",
  number: 42,
  repository: {
    name: "ai-codereviewer",
    owner: { login: "octo-org" },
  },
});

const SYNCHRONIZE_EVENT_FIXTURE = JSON.stringify({
  action: "synchronize",
  before: "1111111111111111111111111111111111111111",
  after: "2222222222222222222222222222222222222222",
  number: 42,
  repository: {
    name: "ai-codereviewer",
    owner: { login: "octo-org" },
  },
});

const SIMPLE_DIFF_FIXTURE = `diff --git a/src/foo.ts b/src/foo.ts
index 4f2d9cd..6f72d11 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = x;
`;

const MULTI_FILE_DIFF_FIXTURE = `diff --git a/src/foo.ts b/src/foo.ts
index 4f2d9cd..6f72d11 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = x;
diff --git a/README.md b/README.md
index 9f5af7c..d4c12ae 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Title
 Some text
+Another line
`;

const mockState = vi.hoisted(() => {
  return {
    inputs: {
      GITHUB_TOKEN: "gh-token",
      OPENAI_API_KEY: "openai-key",
      OPENAI_API_MODEL: "gpt-4-1106-preview",
      exclude: "",
    } as Record<string, string>,
    eventPayload: "",
    diffPayload: "",
    getInput: vi.fn((name: string) => ""),
    info: vi.fn(),
    warning: vi.fn(),
    pullsGet: vi.fn(),
    createReview: vi.fn(),
    compareCommits: vi.fn(),
    createCompletion: vi.fn(),
    readFileSync: vi.fn(),
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
      get: mockState.pullsGet,
      createReview: mockState.createReview,
    };

    repos = {
      compareCommits: mockState.compareCommits,
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

vi.mock("minimatch", () => ({
  default: (filePath: string, pattern: string) => {
    if (!pattern) {
      return false;
    }
    if (pattern === "**/*.md") {
      return filePath.endsWith(".md");
    }
    return filePath === pattern;
  },
}));

vi.mock("fs", () => ({
  readFileSync: mockState.readFileSync,
}));

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

async function runMainModule(): Promise<void> {
  const mod = await import("../../src/main");
  await mod.main();
}

describe("main action flow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.GITHUB_EVENT_PATH = "/tmp/github-event.json";
    process.env.GITHUB_EVENT_NAME = "pull_request";

    mockState.inputs = {
      GITHUB_TOKEN: "gh-token",
      OPENAI_API_KEY: "openai-key",
      OPENAI_API_MODEL: "gpt-4-1106-preview",
      exclude: "",
    };
    mockState.eventPayload = OPENED_EVENT_FIXTURE;
    mockState.diffPayload = SIMPLE_DIFF_FIXTURE;

    mockState.getInput.mockImplementation((name: string) => {
      return mockState.inputs[name] ?? "";
    });

    mockState.readFileSync.mockImplementation(() => mockState.eventPayload);

    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    mockState.pullsGet.mockImplementation(
      async (params: { mediaType?: { format?: string } }) => {
        if (params.mediaType?.format === "diff") {
          return { data: mockState.diffPayload };
        }
        return {
          data: {
            title: "Test PR",
            body: "PR description",
          },
        };
      }
    );

    mockState.compareCommits.mockResolvedValue({ data: mockState.diffPayload });

    mockState.createCompletion.mockImplementation(
      async (params: { messages: Array<{ content: string }> }) => {
        const prompt = params.messages[0]?.content ?? "";
        if (prompt.includes("Provide the response in following JSON format")) {
          return {
            choices: [
              {
                message: {
                  content:
                    '{"reviews":[{"lineNumber":3,"reviewComment":"Potential issue"}]}',
                },
              },
            ],
          };
        }
        return {
          choices: [
            {
              message: {
                content: "- No critical issues found.",
              },
            },
          ],
        };
      }
    );

    mockState.createReview.mockResolvedValue({});
  });

  it("posts inline comments and a summary for opened events", async () => {
    await runMainModule();

    await vi.waitFor(() => {
      expect(mockState.createReview).toHaveBeenCalledTimes(1);
    });

    const payload = mockState.createReview.mock.calls[0][0];
    expect(payload.event).toBe("COMMENT");
    expect(payload.body).toContain("No critical issues found");
    expect(payload.comments).toEqual([
      {
        body: "Potential issue",
        path: "src/foo.ts",
        line: 3,
      },
    ]);
    expect(mockState.createCompletion).toHaveBeenCalledTimes(2);
  });

  it("uses compareCommits diff for synchronize events", async () => {
    mockState.eventPayload = SYNCHRONIZE_EVENT_FIXTURE;

    await runMainModule();

    await vi.waitFor(() => {
      expect(mockState.compareCommits).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(mockState.createReview).toHaveBeenCalledTimes(1);
    });

    expect(mockState.pullsGet).toHaveBeenCalledTimes(1);
  });

  it("respects exclude patterns before analysis", async () => {
    mockState.inputs.exclude = "**/*.md";
    mockState.diffPayload = MULTI_FILE_DIFF_FIXTURE;

    await runMainModule();

    await vi.waitFor(() => {
      expect(mockState.createReview).toHaveBeenCalledTimes(1);
    });

    expect(mockState.createCompletion).toHaveBeenCalledTimes(2);
    const firstPrompt =
      mockState.createCompletion.mock.calls[0][0].messages[0].content;
    expect(firstPrompt).toContain('file "src/foo.ts"');
    expect(firstPrompt).not.toContain("README.md");
  });

  it("retries with summary-only review on 422 errors", async () => {
    mockState.createReview
      .mockRejectedValueOnce({ status: 422 })
      .mockResolvedValueOnce({});

    await runMainModule();

    await vi.waitFor(() => {
      expect(mockState.createReview).toHaveBeenCalledTimes(2);
    });

    const retryPayload = mockState.createReview.mock.calls[1][0];
    expect(retryPayload.comments).toBeUndefined();
    expect(retryPayload.body).toContain("No critical issues found");
    expect(mockState.warning).toHaveBeenCalledTimes(1);
  });

  it("logs and exits early for unsupported events", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockState.eventPayload = JSON.stringify({
      action: "closed",
      number: 42,
      repository: {
        name: "ai-codereviewer",
        owner: { login: "octo-org" },
      },
    });

    await runMainModule();
    await flushAsyncWork();

    expect(logSpy).toHaveBeenCalledWith("Unsupported event:", "pull_request");
    expect(mockState.createReview).not.toHaveBeenCalled();
    expect(mockState.createCompletion).not.toHaveBeenCalled();
  });

  it("does not post inline comments when AI line numbers are invalid", async () => {
    mockState.createCompletion.mockImplementationOnce(async () => {
      return {
        choices: [
          {
            message: {
              content:
                '{"reviews":[{"lineNumber":999,"reviewComment":"Wrong line"}]}',
            },
          },
        ],
      };
    });

    await runMainModule();

    await vi.waitFor(() => {
      expect(mockState.createReview).toHaveBeenCalledTimes(1);
    });

    const payload = mockState.createReview.mock.calls[0][0];
    expect(payload.comments).toBeUndefined();
    expect(payload.body).toContain("No critical issues found");
  });

  it("logs and exits when no diff is available", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mockState.pullsGet.mockImplementation(
      async (params: { mediaType?: { format?: string } }) => {
        if (params.mediaType?.format === "diff") {
          return { data: null };
        }
        return {
          data: {
            title: "Test PR",
            body: "PR description",
          },
        };
      }
    );

    await runMainModule();
    await flushAsyncWork();

    expect(logSpy).toHaveBeenCalledWith("No diff found");
    expect(mockState.createReview).not.toHaveBeenCalled();
  });

  it("still posts summary when inline AI response is invalid JSON", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    mockState.createCompletion.mockImplementationOnce(async () => {
      return {
        choices: [
          {
            message: {
              content: "not-json",
            },
          },
        ],
      };
    });

    await runMainModule();

    await vi.waitFor(() => {
      expect(mockState.createReview).toHaveBeenCalledTimes(1);
    });

    const payload = mockState.createReview.mock.calls[0][0];
    expect(payload.comments).toBeUndefined();
    expect(payload.body).toContain("No critical issues found");
    expect(errorSpy).toHaveBeenCalled();
  });
});
