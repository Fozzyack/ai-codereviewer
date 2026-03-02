import * as core from "@actions/core";

import { RuntimeConfig } from "../types";

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function getRequiredInput(name: string): string {
  return core.getInput(name, { required: true }).trim();
}

export function getOptionalInput(name: string, fallback: string): string {
  const input = core.getInput(name).trim();
  return input || fallback;
}

export function getBoundedIntInput(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const input = core.getInput(name).trim();
  if (!input) {
    return fallback;
  }

  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    core.warning(
      `${name} must be an integer between ${min} and ${max}. Falling back to ${fallback}.`
    );
    return fallback;
  }

  if (parsed < min) {
    core.warning(`${name} must be at least ${min}. Using ${min}.`);
    return min;
  }

  if (parsed > max) {
    core.warning(`${name} must be at most ${max}. Using ${max}.`);
    return max;
  }

  return parsed;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const openAiApiModel = getOptionalInput("OPENAI_API_MODEL", "gpt-4");

  if (!MODEL_ID_PATTERN.test(openAiApiModel)) {
    throw new Error(
      "OPENAI_API_MODEL contains invalid characters. Use letters, numbers, '.', '_', '-', or ':'."
    );
  }

  return {
    githubToken: getRequiredInput("GITHUB_TOKEN"),
    openAiApiKey: getRequiredInput("OPENAI_API_KEY"),
    openAiApiModel,
    includeFixPrompt:
      core.getInput("include_fix_prompt").trim().toLowerCase() !== "false",
    summaryOnce: core.getInput("summary_once").trim().toLowerCase() !== "false",
    fixPromptMaxItems: getBoundedIntInput("fix_prompt_max_items", 20, 1, 200),
    excludeInput: core.getInput("exclude"),
  };
}
