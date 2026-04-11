import { relative } from "node:path";

import { captureFileSnapshot, type CapturedFileSnapshot } from "./file-snapshot";
import type { RepoContext } from "./git";

export type AttributionSource = "ai" | "human" | "system";
export type AttributionEvidenceType = "cursor_hook" | "manual_snapshot" | "reconcile_snapshot";

export interface RawTraceEvent {
  schemaVersion: "0.1.0";
  kind: "cursor_hook_event" | "agent_tracker_event";
  recordedAt: string;
  hookEventName: string;
  repository: {
    root: string;
    gitDir: string;
    currentBranch: string | null;
  };
  cursor: {
    conversationId?: string;
    generationId?: string;
    sessionId?: string;
    model?: string;
    transcriptPath?: string;
    source?: string;
    composerMode?: string;
    reason?: string;
    isBackgroundAgent?: boolean;
  };
  file?: {
    path: string;
    relativePath?: string;
    snapshotId?: string;
    contentHash?: string;
    lineCount?: number;
  };
  shell?: {
    command?: string;
    durationMs?: number;
  };
  attribution: {
    source: AttributionSource;
    evidenceType: AttributionEvidenceType;
    reason?: string;
  };
  payload: Record<string, unknown>;
}

type CursorHookPayload = Record<string, unknown>;

export interface CursorRawTraceRecord {
  event: RawTraceEvent;
  snapshot: CapturedFileSnapshot | null;
}

export async function createCursorRawTraceRecord(
  repo: RepoContext,
  payload: CursorHookPayload,
): Promise<CursorRawTraceRecord> {
  const hookEventName = readString(payload.hook_event_name) ?? "unknown";
  const toolName = readString(payload.tool_name);
  const toolInput = readObject(payload.tool_input) ?? readObject(payload.toolInput);
  const filePath = readString(payload.file_path)
    ?? readString(toolInput?.file_path)
    ?? readString(toolInput?.path);
  const durationMs = readNumber(payload.duration_ms)
    ?? readNumber(payload.duration)
    ?? readNumber(toolInput?.duration_ms)
    ?? readNumber(toolInput?.duration);
  const recordedAt = readIsoTimestamp(payload.recorded_at)
    ?? readIsoTimestamp(payload.timestamp)
    ?? new Date().toISOString();
  const snapshot = filePath
    ? await captureFileSnapshot(repo.repoRoot, filePath, recordedAt)
    : null;

  return {
    event: {
      schemaVersion: "0.1.0",
      kind: "cursor_hook_event",
      recordedAt,
      hookEventName,
      repository: {
        root: repo.repoRoot,
        gitDir: repo.gitDir,
        currentBranch: repo.currentBranch,
      },
      cursor: {
        conversationId: readString(payload.conversation_id),
        generationId: readString(payload.generation_id),
        sessionId: readString(payload.session_id),
        model: readString(payload.model),
        transcriptPath: readString(payload.transcript_path),
        source: readString(payload.source),
        composerMode: readString(payload.composer_mode),
        reason: readString(payload.reason),
        isBackgroundAgent: readBoolean(payload.is_background_agent),
      },
      file: filePath
        ? {
            path: filePath,
            relativePath: snapshot?.relativePath ?? toRepoRelativePath(repo.repoRoot, filePath),
            snapshotId: snapshot?.snapshotId,
            contentHash: snapshot?.contentHash,
            lineCount: snapshot?.lineCount,
          }
        : undefined,
      shell: durationMs !== undefined || readString(payload.command)
        ? {
            command: readString(payload.command) ?? readString(toolInput?.command),
            durationMs,
          }
        : undefined,
      attribution: {
        source: "ai",
        evidenceType: "cursor_hook",
        reason: [hookEventName, toolName].filter((value): value is string => typeof value === "string" && value.length > 0).join(":") || "unknown",
      },
      payload,
    },
    snapshot,
  };
}

export function createHumanSnapshotTraceRecord(
  repo: RepoContext,
  snapshot: CapturedFileSnapshot,
  options: {
    recordedAt: string;
    hookEventName: string;
    evidenceType: Extract<AttributionEvidenceType, "manual_snapshot" | "reconcile_snapshot">;
    reason?: string;
    payload?: Record<string, unknown>;
  },
): RawTraceEvent {
  return {
    schemaVersion: "0.1.0",
    kind: "agent_tracker_event",
    recordedAt: options.recordedAt,
    hookEventName: options.hookEventName,
    repository: {
      root: repo.repoRoot,
      gitDir: repo.gitDir,
      currentBranch: repo.currentBranch,
    },
    cursor: {},
    file: {
      path: `${repo.repoRoot}/${snapshot.relativePath}`,
      relativePath: snapshot.relativePath,
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      lineCount: snapshot.lineCount,
    },
    attribution: {
      source: "human",
      evidenceType: options.evidenceType,
      reason: options.reason,
    },
    payload: options.payload ?? {},
  };
}

function toRepoRelativePath(repoRoot: string, filePath: string): string | undefined {
  const repoRelativePath = relative(repoRoot, filePath);

  if (!repoRelativePath || repoRelativePath.startsWith("..")) {
    return undefined;
  }

  return repoRelativePath;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
