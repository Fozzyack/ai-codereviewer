import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  return {
    eventPayload: "",
    getInput: vi.fn((name: string) => ""),
    pullsGet: vi.fn(),
    compareCommits: vi.fn(),
    createReview: vi.fn(),
    createCompletion: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("@actions/core", () => ({
  getInput: mockState.getInput,
  info: vi.fn(),
  warning: vi.fn(),
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
  default: () => false,
}));

vi.mock("fs", () => ({
  readFileSync: mockState.readFileSync,
}));

import { getRequiredEventPath, main } from "../../src/main";

describe("event payload validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.GITHUB_EVENT_PATH = "/tmp/github-event.json";
    process.env.GITHUB_EVENT_NAME = "pull_request";

    mockState.getInput.mockImplementation((name: string) => {
      if (name === "OPENAI_API_MODEL") {
        return "gpt-4-1106-preview";
      }
      return "value";
    });

    mockState.eventPayload = JSON.stringify({
      action: "opened",
      number: 123,
      repository: {
        name: "repo",
        owner: { login: "owner" },
      },
    });

    mockState.readFileSync.mockImplementation(() => mockState.eventPayload);

    mockState.pullsGet.mockImplementation(
      async (params: { mediaType?: { format?: string } }) => {
        if (params.mediaType?.format === "diff") {
          return {
            data: `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
`,
          };
        }

        return {
          data: {
            title: "Title",
            body: "Body",
          },
        };
      }
    );

    mockState.createCompletion.mockResolvedValue({
      choices: [{ message: { content: '{"reviews":[]}' } }],
    });

    mockState.createReview.mockResolvedValue({});
  });

  it("throws when GITHUB_EVENT_PATH is missing", () => {
    delete process.env.GITHUB_EVENT_PATH;

    expect(() => getRequiredEventPath()).toThrow(
      "GITHUB_EVENT_PATH is not set"
    );
  });

  it("rejects when event payload is invalid JSON", async () => {
    mockState.eventPayload = "not-json";

    await expect(main()).rejects.toThrow();
  });

  it("rejects when repository details are missing in event payload", async () => {
    mockState.eventPayload = JSON.stringify({
      action: "opened",
      number: 123,
    });

    await expect(main()).rejects.toThrow();
  });

  it("rejects when payload has no pull request number", async () => {
    mockState.eventPayload = JSON.stringify({
      action: "opened",
      repository: {
        name: "repo",
        owner: { login: "owner" },
      },
    });

    mockState.pullsGet.mockRejectedValueOnce(
      new Error("Validation Failed: pull_number is required")
    );

    await expect(main()).rejects.toThrow("pull_number is required");
  });
});
