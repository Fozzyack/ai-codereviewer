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

export interface ReviewComment {
  body: string;
  path: string;
  line: number;
}

export interface EventData {
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

export interface RuntimeConfig {
  githubToken: string;
  openAiApiKey: string;
  openAiApiModel: string;
  includeFixPrompt: boolean;
  summaryOnce: boolean;
  fixPromptMaxItems: number;
  excludeInput: string;
}
