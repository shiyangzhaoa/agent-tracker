import type { StatePaths } from './config';
import {
  buildCommitLineAttributionSummary,
  type CommitLineAttributionSummary,
  type CommitFileLineAttributionSummary,
} from './commit-attribution';
import type { AttributionEvidenceSummary } from './line-attribution';
import {
  getLocalGitIdentity,
  getReferenceCommitTime,
  listBranchCommits,
  type CommitFileStat,
  type GitCommitSummary,
} from './git';
import { readRawTraceEvents } from './storage';
import { isIgnoredPath } from './tracker-managed-paths';

const CURSOR_FILE_EVENT_NAMES = new Set([
  'afterFileEdit',
  'afterTabFileEdit',
  'PostToolUse',
  'postToolUse',
]);
const COMMIT_TIME_TOLERANCE_MS = 1500;

interface ObservedCursorFileEvent {
  relativePath: string;
  recordedAt: string;
  recordedAtMs: number;
  model?: string;
  sessionId?: string;
}

export interface CommitCoverageFile {
  path: string;
  status: CommitFileStat['status'];
  previousPath?: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isIgnored: boolean;
  observedByCursor: boolean;
  observedEventCount: number;
  observedAt?: string;
  models: string[];
  sessionIds: string[];
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  removedLines: number;
  aiLineCoveragePercent: number | null;
  humanLineCoveragePercent: number | null;
  unknownLineCoveragePercent: number | null;
  evidenceSummary: AttributionEvidenceSummary;
  hasAttributedDiff: boolean;
}

export interface CommitDataSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  isSelfAuthored: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  observedCursorEventCount: number;
  observedAiFiles: number;
  unknownFiles: number;
  observedAiAdditions: number;
  unknownAdditions: number;
  observedFileCoveragePercent: number | null;
  observedAdditionCoveragePercent: number | null;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  removedLines: number;
  aiLineCoveragePercent: number | null;
  humanLineCoveragePercent: number | null;
  unknownLineCoveragePercent: number | null;
  models: string[];
  sessionIds: string[];
  evidenceSummary: AttributionEvidenceSummary;
  aiStrategy: 'snapshot_hash_match';
  humanStrategy: 'manual_snapshot+reconcile_snapshot+rewrite_of_ai_line';
  files: CommitCoverageFile[];
}

export interface BranchDataSummary {
  sourceBranch: string;
  targetBranch: string;
  baseCommittedAt: string | null;
  commitCount: number;
  selfCommitCount: number;
  teammateCommitCount: number;
  filesChanged: number;
  ignoredFiles: number;
  additions: number;
  deletions: number;
  observedCursorEventCount: number;
  observedAiFiles: number;
  unknownFiles: number;
  observedAiAdditions: number;
  unknownAdditions: number;
  observedFileCoveragePercent: number | null;
  observedAdditionCoveragePercent: number | null;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  removedLines: number;
  aiLineCoveragePercent: number | null;
  humanLineCoveragePercent: number | null;
  unknownLineCoveragePercent: number | null;
  models: string[];
  sessionIds: string[];
  evidenceSummary: AttributionEvidenceSummary;
  aiStrategy: 'snapshot_hash_match';
  humanStrategy: 'manual_snapshot+reconcile_snapshot+rewrite_of_ai_line';
  rawTraceEventsConsidered: number;
  rawTraceInvalidLines: number;
  commits: CommitDataSummary[];
  recentCommits: CommitDataSummary[];
}

interface BuildBranchDataSummaryInput {
  repoRoot: string;
  statePaths: StatePaths;
  sourceBranch: string;
  targetBranch: string;
  sourceRef: string;
  targetRef: string;
  selfEmails: string[];
  selfNames: string[];
  ignore: string[];
}

export async function buildBranchDataSummary(
  input: BuildBranchDataSummaryInput,
): Promise<BranchDataSummary> {
  const commits = listBranchCommits(
    input.repoRoot,
    input.sourceRef,
    input.targetRef,
  );
  const baseCommitTime = getReferenceCommitTime(
    input.repoRoot,
    input.targetRef,
  );
  const baseCommitTimeMs = toEpochMs(baseCommitTime);
  const localIdentity = getLocalGitIdentity(input.repoRoot);
  const identityMatcher = createIdentityMatcher(
    localIdentity.email,
    localIdentity.name,
    input.selfEmails,
    input.selfNames,
  );

  const rawTraceReadResult = await readRawTraceEvents(input.statePaths);
  const observedEvents = rawTraceReadResult.events
    .filter(
      (event) =>
        !event.repository.currentBranch ||
        event.repository.currentBranch === input.sourceBranch,
    )
    .map(toObservedCursorFileEvent)
    .filter((event): event is ObservedCursorFileEvent => event !== null)
    .filter((event) => event.relativePath.length > 0)
    .filter((event) => !isIgnoredPath(event.relativePath, input.ignore));

  const observedEventsByPath = groupObservedEventsByPath(observedEvents);
  const commitSummaries = buildCommitSummaries(
    commits,
    observedEventsByPath,
    baseCommitTimeMs,
    identityMatcher,
    input.ignore,
  );
  const attributedCommitSummaries = commitSummaries.map((commit, index) => {
    const previousAuthoredAt =
      index > 0
        ? (commitSummaries[index - 1]?.authoredAt ?? baseCommitTime)
        : baseCommitTime;
    const lineSummary = buildCommitLineAttributionSummary({
      repoRoot: input.repoRoot,
      statePaths: input.statePaths,
      currentBranch: input.sourceBranch,
      commit,
      previousAuthoredAt,
      ignore: input.ignore,
    });
    const { files: lineSummaryFiles, ...restLineSummary } = lineSummary;

    return {
      ...mergeCommitFileLineAttribution(commit, lineSummaryFiles),
      ...restLineSummary,
    };
  });

  const selfCommitCount = attributedCommitSummaries.filter(
    (commit) => commit.isSelfAuthored,
  ).length;
  const teammateCommitCount =
    attributedCommitSummaries.length - selfCommitCount;

  const uniqueFiles = new Set<string>();
  const uniqueObservedFiles = new Set<string>();
  const ignoredFiles = new Set<string>();

  const additions = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.additions,
    0,
  );
  const deletions = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.deletions,
    0,
  );

  const observedCursorEventCount = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.observedCursorEventCount,
    0,
  );

  for (const commit of attributedCommitSummaries) {
    for (const file of commit.files) {
      if (file.isIgnored) {
        ignoredFiles.add(file.path);
        continue;
      }
      uniqueFiles.add(file.path);
      if (file.observedByCursor || file.aiLines > 0) {
        uniqueObservedFiles.add(file.path);
      }
    }
  }

  const filesChanged = uniqueFiles.size;
  const observedAiFiles = uniqueObservedFiles.size;
  const unknownFiles = Math.max(0, filesChanged - observedAiFiles);

  const observedAiAdditions = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.observedAiAdditions,
    0,
  );
  const unknownAdditions = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.unknownAdditions,
    0,
  );
  const aiLines = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.aiLines,
    0,
  );
  const humanLines = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.humanLines,
    0,
  );
  const unknownLines = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.unknownLines,
    0,
  );
  const removedLines = attributedCommitSummaries.reduce(
    (sum, commit) => sum + commit.removedLines,
    0,
  );

  const models = uniqueStrings(
    attributedCommitSummaries.flatMap((commit) => commit.models),
  );
  const sessionIds = uniqueStrings(
    attributedCommitSummaries.flatMap((commit) => commit.sessionIds),
  );
  const evidenceSummary = mergeEvidenceSummaries(
    attributedCommitSummaries.map((commit) => commit.evidenceSummary),
  );
  const changedLines = aiLines + humanLines + unknownLines;

  return {
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    baseCommittedAt: baseCommitTime,
    commitCount: commitSummaries.length,
    selfCommitCount,
    teammateCommitCount,
    filesChanged,
    ignoredFiles: ignoredFiles.size,
    additions,
    deletions,
    observedCursorEventCount,
    observedAiFiles,
    unknownFiles,
    observedAiAdditions,
    unknownAdditions,
    observedFileCoveragePercent: toPercent(observedAiFiles, filesChanged),
    observedAdditionCoveragePercent: toPercent(observedAiAdditions, additions),
    aiLines,
    humanLines,
    unknownLines,
    removedLines,
    aiLineCoveragePercent: toPercent(aiLines, changedLines),
    humanLineCoveragePercent: toPercent(humanLines, changedLines),
    unknownLineCoveragePercent: toPercent(unknownLines, changedLines),
    models,
    sessionIds,
    evidenceSummary,
    aiStrategy: 'snapshot_hash_match',
    humanStrategy: 'manual_snapshot+reconcile_snapshot+rewrite_of_ai_line',
    rawTraceEventsConsidered: observedEvents.length,
    rawTraceInvalidLines: rawTraceReadResult.invalidLineCount,
    commits: attributedCommitSummaries,
    recentCommits: [...attributedCommitSummaries].reverse().slice(0, 5),
  };
}

function buildCommitSummaries(
  commits: GitCommitSummary[],
  observedEventsByPath: Map<string, ObservedCursorFileEvent[]>,
  baseCommitTimeMs: number | null,
  identityMatcher: (authorEmail: string, authorName: string) => boolean,
  ignore: string[],
): CommitDataSummary[] {
  const summaries: CommitDataSummary[] = [];
  let windowStartMs = baseCommitTimeMs;

  for (const commit of commits) {
    const windowEndMs = laterEpochMs(
      toEpochMs(commit.authoredAt),
      toEpochMs(commit.committedAt),
    );
    const files = commit.files.map((file) => {
      const isIgnored = isIgnoredPath(file.path, ignore);
      return toCommitCoverageFile(
        file,
        observedEventsByPath,
        windowStartMs,
        windowEndMs,
        isIgnored,
      );
    });

    const trackedFiles = files.filter((file) => !file.isIgnored);
    const observedAiFiles = trackedFiles.filter(
      (file) => file.observedByCursor,
    ).length;
    const observedCursorEventCount = trackedFiles.reduce(
      (sum, file) => sum + file.observedEventCount,
      0,
    );
    const observedAiAdditions = trackedFiles
      .filter((file) => file.observedByCursor)
      .reduce((sum, file) => sum + file.additions, 0);
    const trackedAdditions = trackedFiles.reduce(
      (sum, file) => sum + file.additions,
      0,
    );
    const trackedDeletions = trackedFiles.reduce(
      (sum, file) => sum + file.deletions,
      0,
    );

    summaries.push({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authoredAt: commit.authoredAt,
      committedAt: commit.committedAt,
      isSelfAuthored: identityMatcher(commit.authorEmail, commit.authorName),
      filesChanged: trackedFiles.length,
      additions: trackedAdditions,
      deletions: trackedDeletions,
      observedCursorEventCount,
      observedAiFiles,
      unknownFiles: Math.max(0, trackedFiles.length - observedAiFiles),
      observedAiAdditions,
      unknownAdditions: Math.max(0, trackedAdditions - observedAiAdditions),
      observedFileCoveragePercent: toPercent(
        observedAiFiles,
        trackedFiles.length,
      ),
      observedAdditionCoveragePercent: toPercent(
        observedAiAdditions,
        trackedAdditions,
      ),
      aiLines: 0,
      humanLines: 0,
      unknownLines: 0,
      removedLines: 0,
      aiLineCoveragePercent: null,
      humanLineCoveragePercent: null,
      unknownLineCoveragePercent: null,
      models: [],
      sessionIds: [],
      evidenceSummary: createEmptyEvidenceSummary(),
      aiStrategy: 'snapshot_hash_match',
      humanStrategy: 'manual_snapshot+reconcile_snapshot+rewrite_of_ai_line',
      files,
    });

    windowStartMs = toEpochMs(commit.authoredAt) ?? windowStartMs;
  }

  return summaries;
}

function toCommitCoverageFile(
  file: CommitFileStat,
  observedEventsByPath: Map<string, ObservedCursorFileEvent[]>,
  windowStartMs: number | null,
  commitTimeMs: number | null,
  isIgnored: boolean,
): CommitCoverageFile {
  const events = observedEventsByPath.get(file.path) ?? [];
  const matchedEvents = events.filter((event) => {
    if (
      commitTimeMs === null ||
      event.recordedAtMs > commitTimeMs + COMMIT_TIME_TOLERANCE_MS
    ) {
      return false;
    }

    if (windowStartMs === null) {
      return true;
    }

    return event.recordedAtMs > windowStartMs;
  });
  const lastEvent =
    matchedEvents.length > 0
      ? matchedEvents[matchedEvents.length - 1]
      : undefined;

  return {
    path: file.path,
    status: file.status,
    previousPath: file.previousPath,
    additions: file.additions,
    deletions: file.deletions,
    isBinary: file.isBinary,
    isIgnored,
    observedByCursor: matchedEvents.length > 0,
    observedEventCount: matchedEvents.length,
    observedAt: lastEvent?.recordedAt,
    models: uniqueStrings(matchedEvents.map((event) => event.model)),
    sessionIds: uniqueStrings(matchedEvents.map((event) => event.sessionId)),
    aiLines: 0,
    humanLines: 0,
    unknownLines: 0,
    removedLines: 0,
    aiLineCoveragePercent: null,
    humanLineCoveragePercent: null,
    unknownLineCoveragePercent: null,
    evidenceSummary: createEmptyEvidenceSummary(),
    hasAttributedDiff: false,
  };
}

function mergeCommitFileLineAttribution(
  commit: CommitDataSummary,
  lineSummaries: CommitFileLineAttributionSummary[],
): CommitDataSummary {
  const summaryByPath = new Map(
    lineSummaries.map((summary) => [summary.path, summary]),
  );
  const lineSummary = mergeLineSummary(lineSummaries);

  return {
    ...commit,
    aiLines: lineSummary.aiLines,
    humanLines: lineSummary.humanLines,
    unknownLines: lineSummary.unknownLines,
    removedLines: lineSummary.removedLines,
    aiLineCoveragePercent: lineSummary.aiLineCoveragePercent,
    humanLineCoveragePercent: lineSummary.humanLineCoveragePercent,
    unknownLineCoveragePercent: lineSummary.unknownLineCoveragePercent,
    models: lineSummary.models,
    sessionIds: lineSummary.sessionIds,
    evidenceSummary: lineSummary.evidenceSummary,
    files: commit.files.map((file) => {
      const summary = summaryByPath.get(file.path);
      if (!summary) {
        return file;
      }

      return {
        ...file,
        aiLines: summary.aiLines,
        humanLines: summary.humanLines,
        unknownLines: summary.unknownLines,
        removedLines: summary.removedLines,
        aiLineCoveragePercent: summary.aiLineCoveragePercent,
        humanLineCoveragePercent: summary.humanLineCoveragePercent,
        unknownLineCoveragePercent: summary.unknownLineCoveragePercent,
        models: summary.models.length > 0 ? summary.models : file.models,
        sessionIds:
          summary.sessionIds.length > 0 ? summary.sessionIds : file.sessionIds,
        evidenceSummary: summary.evidenceSummary,
        hasAttributedDiff: summary.hasAttributedDiff,
      };
    }),
  };
}

function mergeLineSummary(
  lineSummaries: CommitFileLineAttributionSummary[],
): CommitLineAttributionSummary {
  const aiLines = lineSummaries.reduce((sum, file) => sum + file.aiLines, 0);
  const humanLines = lineSummaries.reduce(
    (sum, file) => sum + file.humanLines,
    0,
  );
  const unknownLines = lineSummaries.reduce(
    (sum, file) => sum + file.unknownLines,
    0,
  );
  const removedLines = lineSummaries.reduce(
    (sum, file) => sum + file.removedLines,
    0,
  );
  const changedLines = aiLines + humanLines + unknownLines;

  return {
    aiLines,
    humanLines,
    unknownLines,
    removedLines,
    aiLineCoveragePercent: toPercent(aiLines, changedLines),
    humanLineCoveragePercent: toPercent(humanLines, changedLines),
    unknownLineCoveragePercent: toPercent(unknownLines, changedLines),
    models: uniqueStrings(lineSummaries.flatMap((file) => file.models)),
    sessionIds: uniqueStrings(lineSummaries.flatMap((file) => file.sessionIds)),
    evidenceSummary: mergeEvidenceSummaries(
      lineSummaries.map((file) => file.evidenceSummary),
    ),
    files: lineSummaries,
    aiStrategy: 'snapshot_hash_match',
    humanStrategy: 'manual_snapshot+reconcile_snapshot+rewrite_of_ai_line',
  };
}

function createEmptyEvidenceSummary(): AttributionEvidenceSummary {
  return {
    aiHashMatchLines: 0,
    humanSnapshotLines: 0,
    humanManualSnapshotLines: 0,
    humanReconcileSnapshotLines: 0,
    humanRewriteLines: 0,
    removedAiSourceLines: 0,
    removedHumanSourceLines: 0,
    removedUnknownSourceLines: 0,
  };
}

function mergeEvidenceSummaries(
  summaries: AttributionEvidenceSummary[],
): AttributionEvidenceSummary {
  const merged = createEmptyEvidenceSummary();

  for (const summary of summaries) {
    merged.aiHashMatchLines += summary.aiHashMatchLines;
    merged.humanSnapshotLines += summary.humanSnapshotLines;
    merged.humanManualSnapshotLines += summary.humanManualSnapshotLines;
    merged.humanReconcileSnapshotLines += summary.humanReconcileSnapshotLines;
    merged.humanRewriteLines += summary.humanRewriteLines;
    merged.removedAiSourceLines += summary.removedAiSourceLines;
    merged.removedHumanSourceLines += summary.removedHumanSourceLines;
    merged.removedUnknownSourceLines += summary.removedUnknownSourceLines;
  }

  return merged;
}

function groupObservedEventsByPath(
  events: ObservedCursorFileEvent[],
): Map<string, ObservedCursorFileEvent[]> {
  const grouped = new Map<string, ObservedCursorFileEvent[]>();

  for (const event of events) {
    const existing = grouped.get(event.relativePath) ?? [];
    existing.push(event);
    grouped.set(event.relativePath, existing);
  }

  for (const entry of grouped.values()) {
    entry.sort((left, right) => left.recordedAtMs - right.recordedAtMs);
  }

  return grouped;
}

function toObservedCursorFileEvent(event: {
  hookEventName?: string;
  recordedAt?: string;
  repository?: { currentBranch?: string | null };
  file?: { relativePath?: string };
  cursor?: { model?: string; sessionId?: string };
}): ObservedCursorFileEvent | null {
  if (
    !event.hookEventName ||
    !CURSOR_FILE_EVENT_NAMES.has(event.hookEventName)
  ) {
    return null;
  }

  const relativePath = event.file?.relativePath?.trim();
  if (!relativePath) {
    return null;
  }

  const recordedAt = event.recordedAt ?? '';
  const recordedAtMs = toEpochMs(recordedAt);
  if (recordedAtMs === null) {
    return null;
  }

  return {
    relativePath,
    recordedAt,
    recordedAtMs,
    model: event.cursor?.model,
    sessionId: event.cursor?.sessionId,
  };
}

function createIdentityMatcher(
  localEmail: string | null,
  localName: string | null,
  selfEmails: string[],
  selfNames: string[],
): (authorEmail: string, authorName: string) => boolean {
  const emailSet = new Set(
    [localEmail, ...selfEmails]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      .map(normalizeIdentityValue),
  );
  const nameSet = new Set(
    [localName, ...selfNames]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      .map(normalizeIdentityValue),
  );

  return (authorEmail: string, authorName: string) => {
    const normalizedEmail = normalizeIdentityValue(authorEmail);
    const normalizedName = normalizeIdentityValue(authorName);

    return emailSet.has(normalizedEmail) || nameSet.has(normalizedName);
  };
}

function normalizeIdentityValue(value: string): string {
  return value.trim().toLowerCase();
}

function toEpochMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function laterEpochMs(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function toPercent(part: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }

  return Math.round((part / total) * 1000) / 10;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      ),
    ),
  ];
}
