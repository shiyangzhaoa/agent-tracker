import { createHash } from "node:crypto";

import type { RawTraceEvent } from "./raw-trace";

export interface NormalizedTraceEvent {
  id: string;
  recordedAt: string;
  hookEventName: string;
  category: "file_edit" | "shell" | "session" | "other";
  currentBranch: string | null;
  relativePath: string | null;
  snapshotId: string | null;
  contentHash: string | null;
  lineCount: number | null;
  model: string | null;
  sessionId: string | null;
  conversationId: string | null;
  generationId: string | null;
}

export function normalizeRawTraceEvent(event: RawTraceEvent): NormalizedTraceEvent {
  return {
    id: buildNormalizedTraceEventId(event),
    recordedAt: event.recordedAt,
    hookEventName: event.hookEventName,
    category: toEventCategory(event.hookEventName),
    currentBranch: event.repository.currentBranch ?? null,
    relativePath: event.file?.relativePath ?? null,
    snapshotId: event.file?.snapshotId ?? null,
    contentHash: event.file?.contentHash ?? null,
    lineCount: typeof event.file?.lineCount === "number" ? event.file.lineCount : null,
    model: event.cursor.model ?? null,
    sessionId: event.cursor.sessionId ?? null,
    conversationId: event.cursor.conversationId ?? null,
    generationId: event.cursor.generationId ?? null,
  };
}

function buildNormalizedTraceEventId(event: RawTraceEvent): string {
  return createHash("sha256")
    .update(JSON.stringify(event))
    .digest("hex");
}

function toEventCategory(hookEventName: string): NormalizedTraceEvent["category"] {
  if (hookEventName === "afterFileEdit" || hookEventName === "afterTabFileEdit") {
    return "file_edit";
  }

  if (hookEventName === "afterShellExecution") {
    return "shell";
  }

  if (hookEventName === "sessionStart" || hookEventName === "sessionEnd") {
    return "session";
  }

  return "other";
}
