import type { StatePaths } from "./config";
import {
  getLocalGitIdentity,
  getReferenceCommitTime,
  listBranchCommits,
  type CommitFileStat,
  type GitCommitSummary,
} from "./git";
import { readRawTraceEvents } from "./storage";

const CURSOR_FILE_EVENT_NAMES = new Set([
  "afterFileEdit",
  "afterTabFileEdit",
]);

interface ObservedCursorFileEvent {
  relativePath: string;
  recordedAt: string;
  recordedAtMs: number;
  model?: string;
  sessionId?: string;
}

export interface CommitCoverageFile {
  path: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  observedByCursor: boolean;
  observedAt?: string;
  models: string[];
  sessionIds: string[];
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
  observedAiFiles: number;
  unknownFiles: number;
  observedAiAdditions: number;
  unknownAdditions: number;
  observedFileCoveragePercent: number | null;
  observedAdditionCoveragePercent: number | null;
  files: CommitCoverageFile[];
}

export interface BranchDataSummary {
  sourceBranch: string;
  targetBranch: string;
  commitCount: number;
  selfCommitCount: number;
  teammateCommitCount: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  observedAiFiles: number;
  unknownFiles: number;
  observedAiAdditions: number;
  unknownAdditions: number;
  observedFileCoveragePercent: number | null;
  observedAdditionCoveragePercent: number | null;
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
}

export async function buildBranchDataSummary(
  input: BuildBranchDataSummaryInput,
): Promise<BranchDataSummary> {
  const commits = listBranchCommits(input.repoRoot, input.sourceRef, input.targetRef);
  const baseCommitTime = getReferenceCommitTime(input.repoRoot, input.targetRef);
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
    .filter((event) => !event.repository.currentBranch || event.repository.currentBranch === input.sourceBranch)
    .map(toObservedCursorFileEvent)
    .filter((event): event is ObservedCursorFileEvent => event !== null)
    .filter((event) => event.relativePath.length > 0);

  const observedEventsByPath = groupObservedEventsByPath(observedEvents);
  const commitSummaries = buildCommitSummaries(
    commits,
    observedEventsByPath,
    baseCommitTimeMs,
    identityMatcher,
  );

  const selfCommitCount = commitSummaries.filter((commit) => commit.isSelfAuthored).length;
  const teammateCommitCount = commitSummaries.length - selfCommitCount;
  const filesChanged = commitSummaries.reduce((sum, commit) => sum + commit.filesChanged, 0);
  const additions = commitSummaries.reduce((sum, commit) => sum + commit.additions, 0);
  const deletions = commitSummaries.reduce((sum, commit) => sum + commit.deletions, 0);
  const observedAiFiles = commitSummaries.reduce((sum, commit) => sum + commit.observedAiFiles, 0);
  const unknownFiles = commitSummaries.reduce((sum, commit) => sum + commit.unknownFiles, 0);
  const observedAiAdditions = commitSummaries.reduce((sum, commit) => sum + commit.observedAiAdditions, 0);
  const unknownAdditions = commitSummaries.reduce((sum, commit) => sum + commit.unknownAdditions, 0);

  return {
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    commitCount: commitSummaries.length,
    selfCommitCount,
    teammateCommitCount,
    filesChanged,
    additions,
    deletions,
    observedAiFiles,
    unknownFiles,
    observedAiAdditions,
    unknownAdditions,
    observedFileCoveragePercent: toPercent(observedAiFiles, filesChanged),
    observedAdditionCoveragePercent: toPercent(observedAiAdditions, additions),
    rawTraceEventsConsidered: observedEvents.length,
    rawTraceInvalidLines: rawTraceReadResult.invalidLineCount,
    commits: commitSummaries,
    recentCommits: [...commitSummaries].reverse().slice(0, 5),
  };
}

function buildCommitSummaries(
  commits: GitCommitSummary[],
  observedEventsByPath: Map<string, ObservedCursorFileEvent[]>,
  baseCommitTimeMs: number | null,
  identityMatcher: (authorEmail: string, authorName: string) => boolean,
): CommitDataSummary[] {
  const summaries: CommitDataSummary[] = [];
  let windowStartMs = baseCommitTimeMs;

  for (const commit of commits) {
    const commitTimeMs = toEpochMs(commit.committedAt);
    const files = commit.files.map((file) => toCommitCoverageFile(file, observedEventsByPath, windowStartMs, commitTimeMs));
    const observedAiFiles = files.filter((file) => file.observedByCursor).length;
    const observedAiAdditions = files
      .filter((file) => file.observedByCursor)
      .reduce((sum, file) => sum + file.additions, 0);

    summaries.push({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authoredAt: commit.authoredAt,
      committedAt: commit.committedAt,
      isSelfAuthored: identityMatcher(commit.authorEmail, commit.authorName),
      filesChanged: commit.filesChanged,
      additions: commit.additions,
      deletions: commit.deletions,
      observedAiFiles,
      unknownFiles: Math.max(0, commit.filesChanged - observedAiFiles),
      observedAiAdditions,
      unknownAdditions: Math.max(0, commit.additions - observedAiAdditions),
      observedFileCoveragePercent: toPercent(observedAiFiles, commit.filesChanged),
      observedAdditionCoveragePercent: toPercent(observedAiAdditions, commit.additions),
      files,
    });

    if (commitTimeMs !== null) {
      windowStartMs = commitTimeMs;
    }
  }

  return summaries;
}

function toCommitCoverageFile(
  file: CommitFileStat,
  observedEventsByPath: Map<string, ObservedCursorFileEvent[]>,
  windowStartMs: number | null,
  commitTimeMs: number | null,
): CommitCoverageFile {
  const events = observedEventsByPath.get(file.path) ?? [];
  const matchedEvents = events.filter((event) => {
    if (commitTimeMs === null || event.recordedAtMs > commitTimeMs) {
      return false;
    }

    if (windowStartMs === null) {
      return true;
    }

    return event.recordedAtMs > windowStartMs;
  });
  const lastEvent = matchedEvents.length > 0 ? matchedEvents[matchedEvents.length - 1] : undefined;

  return {
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    isBinary: file.isBinary,
    observedByCursor: matchedEvents.length > 0,
    observedAt: lastEvent?.recordedAt,
    models: uniqueStrings(matchedEvents.map((event) => event.model)),
    sessionIds: uniqueStrings(matchedEvents.map((event) => event.sessionId)),
  };
}

function groupObservedEventsByPath(events: ObservedCursorFileEvent[]): Map<string, ObservedCursorFileEvent[]> {
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
  if (!event.hookEventName || !CURSOR_FILE_EVENT_NAMES.has(event.hookEventName)) {
    return null;
  }

  const relativePath = event.file?.relativePath?.trim();
  if (!relativePath) {
    return null;
  }

  const recordedAt = event.recordedAt ?? "";
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
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map(normalizeIdentityValue),
  );
  const nameSet = new Set(
    [localName, ...selfNames]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
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

function toPercent(part: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }

  return Math.round((part / total) * 1000) / 10;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}
