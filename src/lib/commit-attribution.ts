import type { StatePaths } from "./config";
import {
  buildCommitFileAttribution,
  type AttributionEvidenceSummary,
} from "./line-attribution";
import { isIgnoredPath } from "./tracker-managed-paths";

interface CommitAttributionFile {
  path: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

interface CommitAttributionCommit {
  sha: string;
  committedAt: string;
  files: CommitAttributionFile[];
}

export interface CommitLineAttributionSummary {
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
  files: CommitFileLineAttributionSummary[];
  aiStrategy: "snapshot_hash_match";
  humanStrategy: "manual_snapshot+reconcile_snapshot+rewrite_of_ai_line";
}

export interface CommitFileLineAttributionSummary {
  path: string;
  isIgnored: boolean;
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
  hasAttributedDiff: boolean;
}

interface BuildCommitLineAttributionSummaryInput {
  repoRoot: string;
  statePaths: StatePaths;
  currentBranch: string;
  commit: CommitAttributionCommit;
  previousCommittedAt: string | null;
  ignore: string[];
}

export function buildCommitLineAttributionSummary(
  input: BuildCommitLineAttributionSummaryInput,
): CommitLineAttributionSummary {
  let aiLines = 0;
  let humanLines = 0;
  let unknownLines = 0;
  let removedLines = 0;
  const models = new Set<string>();
  const sessionIds = new Set<string>();
  const evidenceSummary = createEmptyEvidenceSummary();
  const files: CommitFileLineAttributionSummary[] = [];

  for (const file of input.commit.files) {
    const isIgnored = isIgnoredPath(file.path, input.ignore);

    if (isIgnored) {
      files.push({
        path: file.path,
        isIgnored: true,
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
        hasAttributedDiff: false,
      });
      continue;
    }

    if (file.isBinary) {
      files.push({
        path: file.path,
        isIgnored: false,
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
        hasAttributedDiff: false,
      });
      continue;
    }

    const attribution = buildCommitFileAttribution({
      repoRoot: input.repoRoot,
      statePaths: input.statePaths,
      currentBranch: input.currentBranch,
      commit: input.commit,
      previousCommittedAt: input.previousCommittedAt,
      file,
    });

    if (!attribution) {
      files.push({
        path: file.path,
        isIgnored: false,
        aiLines: 0,
        humanLines: 0,
        unknownLines: Math.max(0, file.additions),
        removedLines: Math.max(0, file.deletions),
        aiLineCoveragePercent: toPercent(0, Math.max(0, file.additions)),
        humanLineCoveragePercent: toPercent(0, Math.max(0, file.additions)),
        unknownLineCoveragePercent: toPercent(Math.max(0, file.additions), Math.max(0, file.additions)),
        models: [],
        sessionIds: [],
        evidenceSummary: {
          ...createEmptyEvidenceSummary(),
          removedUnknownSourceLines: Math.max(0, file.deletions),
        },
        hasAttributedDiff: false,
      });
      unknownLines += Math.max(0, file.additions);
      removedLines += Math.max(0, file.deletions);
      evidenceSummary.removedUnknownSourceLines += Math.max(0, file.deletions);
      continue;
    }

    aiLines += attribution.aiLines;
    humanLines += attribution.humanLines;
    unknownLines += attribution.unknownLines;
    removedLines += attribution.removedLines;
    mergeEvidenceSummary(evidenceSummary, attribution.evidenceSummary);

    for (const hunk of attribution.hunks) {
      for (const line of hunk.lines) {
        if (line.attribution !== "ai" && line.attribution !== "human") {
          continue;
        }

        for (const model of line.models) {
          models.add(model);
        }
        for (const sessionId of line.sessionIds) {
          sessionIds.add(sessionId);
        }
      }
    }

    const changedLines = attribution.aiLines + attribution.humanLines + attribution.unknownLines;
    files.push({
      path: file.path,
      isIgnored: false,
      aiLines: attribution.aiLines,
      humanLines: attribution.humanLines,
      unknownLines: attribution.unknownLines,
      removedLines: attribution.removedLines,
      aiLineCoveragePercent: toPercent(attribution.aiLines, changedLines),
      humanLineCoveragePercent: toPercent(attribution.humanLines, changedLines),
      unknownLineCoveragePercent: toPercent(attribution.unknownLines, changedLines),
      models: [...new Set(
        attribution.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (
          line.attribution === "ai" || line.attribution === "human" ? line.models : []
        ))),
      )],
      sessionIds: [...new Set(
        attribution.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (
          line.attribution === "ai" || line.attribution === "human" ? line.sessionIds : []
        ))),
      )],
      evidenceSummary: attribution.evidenceSummary,
      hasAttributedDiff: true,
    });
  }

  const changedLines = aiLines + humanLines + unknownLines;

  return {
    aiLines,
    humanLines,
    unknownLines,
    removedLines,
    aiLineCoveragePercent: toPercent(aiLines, changedLines),
    humanLineCoveragePercent: toPercent(humanLines, changedLines),
    unknownLineCoveragePercent: toPercent(unknownLines, changedLines),
    models: [...models],
    sessionIds: [...sessionIds],
    evidenceSummary,
    files,
    aiStrategy: "snapshot_hash_match",
    humanStrategy: "manual_snapshot+reconcile_snapshot+rewrite_of_ai_line",
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

function mergeEvidenceSummary(
  target: AttributionEvidenceSummary,
  next: AttributionEvidenceSummary,
): void {
  target.aiHashMatchLines += next.aiHashMatchLines;
  target.humanSnapshotLines += next.humanSnapshotLines;
  target.humanManualSnapshotLines += next.humanManualSnapshotLines;
  target.humanReconcileSnapshotLines += next.humanReconcileSnapshotLines;
  target.humanRewriteLines += next.humanRewriteLines;
  target.removedAiSourceLines += next.removedAiSourceLines;
  target.removedHumanSourceLines += next.removedHumanSourceLines;
  target.removedUnknownSourceLines += next.removedUnknownSourceLines;
}

function toPercent(value: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }

  return Number(((value / total) * 100).toFixed(1));
}
