import { relative } from "node:path";

import { captureFileSnapshot, type CapturedFileSnapshot } from "./file-snapshot";
import type { RepoContext } from "./git";

export interface RawTraceEvent {
  schemaVersion: "0.1.0";
  kind: "cursor_hook_event";
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
  const filePath = readString(payload.file_path);
  const durationMs = readNumber(payload.duration_ms) ?? readNumber(payload.duration);
  const recordedAt = new Date().toISOString();
  const snapshot = filePath
    ? await captureFileSnapshot(repo.repoRoot, filePath, recordedAt)
    : null;

  return {
    event: {
      schemaVersion: "0.1.0",
      kind: "cursor_hook_event",
      recordedAt,
      hookEventName: readString(payload.hook_event_name) ?? "unknown",
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
            command: readString(payload.command),
            durationMs,
          }
        : undefined,
      payload,
    },
    snapshot,
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
