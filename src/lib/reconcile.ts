import type { StatePaths } from './config';
import { captureFileSnapshot } from './file-snapshot';
import {
  listTrackedFiles,
  listWorkingTreeFiles,
  type RepoContext,
} from './git';
import { createHumanSnapshotTraceRecord } from './raw-trace';
import {
  appendFileSnapshot,
  appendRawTraceEvent,
  ensureStateLayout,
  listFileSnapshotMetadata,
} from './storage';
import { isIgnoredPath } from './tracker-managed-paths';

export interface ReconcileSummary {
  capturedCount: number;
  skippedCount: number;
}

interface CaptureHumanEvidenceOptions {
  hookEventName?:
    | 'agentTracker.manualSnapshot'
    | 'agentTracker.reconcileSnapshot';
  evidenceType?: 'manual_snapshot' | 'reconcile_snapshot';
  reasonPrefix?: string;
  ignore?: string[];
}

export async function captureHumanEvidenceSnapshots(
  repo: RepoContext,
  statePaths: StatePaths,
  options: CaptureHumanEvidenceOptions = {},
): Promise<ReconcileSummary> {
  await ensureStateLayout(statePaths);

  const existingSnapshots = await listFileSnapshotMetadata(statePaths);
  const knownContentHashesByPath = new Map<string, Set<string>>();

  for (const snapshot of existingSnapshots) {
    const existing =
      knownContentHashesByPath.get(snapshot.relativePath) ?? new Set<string>();
    existing.add(snapshot.contentHash);
    knownContentHashesByPath.set(snapshot.relativePath, existing);
  }

  const dirtyFiles = listWorkingTreeFiles(repo.repoRoot);
  const trackedFiles = listTrackedFiles(repo.repoRoot);
  const dirtyPaths = new Set(dirtyFiles.map((f) => f.path));
  const allFiles = [
    ...dirtyFiles,
    ...trackedFiles.filter((f) => !dirtyPaths.has(f.path)),
  ];

  let capturedCount = 0;
  let skippedCount = 0;
  const hookEventName = options.hookEventName ?? 'agentTracker.manualSnapshot';
  const evidenceType = options.evidenceType ?? 'manual_snapshot';
  const reasonPrefix = options.reasonPrefix ?? 'working-tree';
  const ignorePatterns = options.ignore ?? [];

  for (const entry of allFiles) {
    if (isIgnoredPath(entry.path, ignorePatterns)) {
      skippedCount += 1;
      continue;
    }

    const recordedAt = new Date().toISOString();
    const snapshot = await captureFileSnapshot(
      repo.repoRoot,
      entry.absolutePath,
      recordedAt,
    );

    if (!snapshot) {
      skippedCount += 1;
      continue;
    }

    const knownHashes =
      knownContentHashesByPath.get(snapshot.relativePath) ?? new Set<string>();
    if (knownHashes.has(snapshot.contentHash)) {
      skippedCount += 1;
      continue;
    }

    const event = createHumanSnapshotTraceRecord(repo, snapshot, {
      recordedAt,
      hookEventName,
      evidenceType,
      reason: `${reasonPrefix}:${entry.status.trim()}`,
      payload: {
        status: entry.status,
      },
    });

    await appendRawTraceEvent(statePaths, event);
    await appendFileSnapshot(statePaths, snapshot);

    knownHashes.add(snapshot.contentHash);
    knownContentHashesByPath.set(snapshot.relativePath, knownHashes);
    capturedCount += 1;
  }

  return {
    capturedCount,
    skippedCount,
  };
}
