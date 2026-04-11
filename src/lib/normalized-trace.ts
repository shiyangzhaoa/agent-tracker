import { createHash } from 'node:crypto';

import type { RawTraceEvent } from './raw-trace';

export interface NormalizedTraceEvent {
  id: string;
  recordedAt: string;
  recordedAtMs: number;
  hookEventName: string;
  category: 'file_edit' | 'human_snapshot' | 'shell' | 'session' | 'other';
  currentBranch: string | null;
  relativePath: string | null;
  snapshotId: string | null;
  contentHash: string | null;
  lineCount: number | null;
  attributionSource: 'ai' | 'human' | 'system';
  evidenceType: string | null;
  model: string | null;
  sessionId: string | null;
  conversationId: string | null;
  generationId: string | null;
}

export function normalizeRawTraceEvent(
  event: RawTraceEvent,
): NormalizedTraceEvent {
  const attribution = readAttribution(event);

  return {
    id: buildNormalizedTraceEventId(event),
    recordedAt: event.recordedAt,
    recordedAtMs: toEpochMs(event.recordedAt),
    hookEventName: event.hookEventName,
    category: toEventCategory(event.hookEventName),
    currentBranch: event.repository.currentBranch ?? null,
    relativePath: event.file?.relativePath ?? null,
    snapshotId: event.file?.snapshotId ?? null,
    contentHash: event.file?.contentHash ?? null,
    lineCount:
      typeof event.file?.lineCount === 'number' ? event.file.lineCount : null,
    attributionSource: attribution.source,
    evidenceType: attribution.evidenceType,
    model: event.cursor.model ?? null,
    sessionId: event.cursor.sessionId ?? null,
    conversationId: event.cursor.conversationId ?? null,
    generationId: event.cursor.generationId ?? null,
  };
}

function toEpochMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildNormalizedTraceEventId(event: RawTraceEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function readAttribution(event: RawTraceEvent): {
  source: NormalizedTraceEvent['attributionSource'];
  evidenceType: string | null;
} {
  if (event.attribution?.source) {
    return {
      source: event.attribution.source,
      evidenceType: event.attribution.evidenceType ?? null,
    };
  }

  if (event.kind === 'cursor_hook_event') {
    return {
      source: 'ai',
      evidenceType: 'cursor_hook',
    };
  }

  if (event.hookEventName === 'agentTracker.manualSnapshot') {
    return {
      source: 'human',
      evidenceType: 'manual_snapshot',
    };
  }

  if (event.hookEventName === 'agentTracker.reconcileSnapshot') {
    return {
      source: 'human',
      evidenceType: 'reconcile_snapshot',
    };
  }

  return {
    source: 'system',
    evidenceType: null,
  };
}

function toEventCategory(
  hookEventName: string,
): NormalizedTraceEvent['category'] {
  if (
    hookEventName === 'agentTracker.reconcileSnapshot' ||
    hookEventName === 'agentTracker.manualSnapshot'
  ) {
    return 'human_snapshot';
  }

  if (
    hookEventName === 'afterFileEdit' ||
    hookEventName === 'afterTabFileEdit' ||
    hookEventName === 'PostToolUse' ||
    hookEventName === 'postToolUse'
  ) {
    return 'file_edit';
  }

  if (hookEventName === 'afterShellExecution') {
    return 'shell';
  }

  if (
    hookEventName === 'sessionStart' ||
    hookEventName === 'sessionEnd' ||
    hookEventName === 'SessionStart' ||
    hookEventName === 'SessionEnd'
  ) {
    return 'session';
  }

  return 'other';
}
