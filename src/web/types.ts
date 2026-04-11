export type SnapshotTone = "ok" | "warn" | "fail";

export interface WorkingTreeStatusFile {
  path: string;
  status: string;
  previousPath?: string;
}

export interface AttributionEvidenceSummary {
  aiHashMatchLines: number;
  humanSnapshotLines: number;
  humanManualSnapshotLines: number;
  humanReconcileSnapshotLines: number;
  humanRewriteLines: number;
  removedAiSourceLines: number;
  removedHumanSourceLines: number;
  removedUnknownSourceLines: number;
}

export interface CommitCoverageFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "changed";
  previousPath?: string;
  additions: number;
  deletions: number;
  isIgnored: boolean;
  observedEventCount: number;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  removedLines: number;
  aiLineCoveragePercent: number | null;
  humanLineCoveragePercent: number | null;
  unknownLineCoveragePercent: number | null;
  models: string[];
  evidenceSummary: AttributionEvidenceSummary;
  hasAttributedDiff: boolean;
}

export interface CommitDataSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  isSelfAuthored: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  observedCursorEventCount: number;
  observedAiFiles: number;
  observedAiAdditions: number;
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
  aiStrategy: string;
  humanStrategy: string;
  files: CommitCoverageFile[];
}

export interface BranchDataSummary {
  sourceBranch: string;
  targetBranch: string;
  commitCount: number;
  selfCommitCount: number;
  teammateCommitCount: number;
  filesChanged: number;
  ignoredFiles: number;
  additions: number;
  deletions: number;
  observedCursorEventCount: number;
  observedAiFiles: number;
  observedAiAdditions: number;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  removedLines: number;
  aiLineCoveragePercent: number | null;
  humanLineCoveragePercent: number | null;
  unknownLineCoveragePercent: number | null;
  observedFileCoveragePercent: number | null;
  models: string[];
  sessionIds: string[];
  evidenceSummary: AttributionEvidenceSummary;
  aiStrategy: string;
  humanStrategy: string;
  rawTraceEventsConsidered?: number;
  commits: CommitDataSummary[];
  recentCommits: CommitDataSummary[];
}

export interface CommitFileAttribution {
  path: string;
  patch: string;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  removedLines: number;
  evidenceSummary: AttributionEvidenceSummary;
  hunks: Array<{
    header: string;
    lines: Array<{
      kind: "context" | "add" | "remove";
      text: string;
      oldLineNumber: number | null;
      newLineNumber: number | null;
      attribution: "context" | "remove" | "ai" | "human" | "unknown";
      evidence: "none" | "snapshot_hash_match" | "explicit_human_snapshot" | "rewrite_of_ai_line";
      sourceAttribution: "none" | "ai" | "human";
      inlineSegments: Array<{
        text: string;
        attribution: "ai" | "human" | "unknown" | "source";
      }>;
      models: string[];
      sessionIds: string[];
    }>;
  }>;
}

export interface EffectiveConfig {
  sourceBranch: string;
  targetBranch: string;
  storageRoot: string;
  webPort: number;
  ffCheck: boolean;
  fetchBeforeCompare: boolean;
  cursorHooksEnabled: boolean;
  selfEmails: string[];
  selfNames: string[];
  ignore: string[];
}

export interface LoadedConfig {
  config: EffectiveConfig;
  sources: Record<keyof EffectiveConfig, string>;
  projectConfigPath: string;
  localConfigPath: string;
  projectConfigExists: boolean;
  localConfigExists: boolean;
  projectConfigMissingKeys: string[];
}

export interface AppSnapshot {
  available: boolean;
  tone: SnapshotTone;
  summary: string;
  repoRoot?: string;
  storageRootExists?: boolean;
  cursorInstalled?: boolean;
  currentBranch?: string | null;
  sourceBranch?: string;
  targetBranch?: string;
  webPort?: number;
  rawTraceEvents?: number;
  normalizedTraceEvents?: number;
  normalizedHumanSnapshotEvents?: number;
  normalizedManualSnapshotEvents?: number;
  normalizedReconcileSnapshotEvents?: number;
  fileSnapshots?: number;
  dirtyCount?: number;
  workingTreeFiles?: WorkingTreeStatusFile[];
  ahead?: number | null;
  behind?: number | null;
  canFastForward?: boolean | null;
  projectConfigExists?: boolean;
  localConfigExists?: boolean;
  projectConfigPath?: string;
  localConfigPath?: string;
  projectConfigMissingKeys?: string[];
  loadedConfig?: LoadedConfig;
  branchData?: BranchDataSummary;
  issues: string[];
}
