import { readFileSync } from "fs";

import { EventData } from "../types";

export function getRequiredEventPath(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is not set");
  }
  return eventPath;
}

export function getEventData(): EventData {
  const eventRaw = readFileSync(getRequiredEventPath(), "utf8");
  const eventData = JSON.parse(eventRaw) as Partial<EventData>;

  if (
    !eventData.repository?.owner?.login ||
    !eventData.repository?.name ||
    typeof eventData.number !== "number" ||
    !eventData.action
  ) {
    throw new Error(
      "GitHub event payload is missing required pull request fields"
    );
  }

  return eventData as EventData;
}
