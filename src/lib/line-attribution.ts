import { Database } from "bun:sqlite";
import { diffWordsWithSpace } from "diff";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import type { StatePaths } from "./config";
import {
  readCommitFileDiff,
  type CommitDiffHunkLine,
} from "./git";

const COMMIT_TIME_TOLERANCE_MS = 1500;
const HUMAN_REWRITE_SIMILARITY_THRESHOLD = 0.42;

export interface InlineAttributionSegment {
  text: string;
  attribution: "ai" | "human" | "unknown" | "source";
}

export interface AttributedDiffLine extends CommitDiffHunkLine {
  attribution: "context" | "remove" | "ai" | "human" | "unknown";
  evidence: "none" | "snapshot_hash_match" | "explicit_human_snapshot" | "rewrite_of_ai_line";
  models: string[];
  sessionIds: string[];
  sourceAttribution: "none" | "ai" | "human";
  inlineSegments: InlineAttributionSegment[];
}

export interface AttributedDiffHunk {
  header: string;
  lines: AttributedDiffLine[];
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

export interface CommitFileAttribution {
  path: string;
  patch: string;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  removedLines: number;
  evidenceSummary: AttributionEvidenceSummary;
  hunks: AttributedDiffHunk[];
}

interface SnapshotLineMatch {
  models: Set<string>;
  sessionIds: Set<string>;
  evidenceTypes: Set<string>;
}

interface AttributionCommit {
  sha: string;
  committedAt: string;
}

interface AttributionFile {
  path: string;
}

interface BuildCommitFileAttributionInput {
  repoRoot: string;
  statePaths: StatePaths;
  currentBranch: string;
  commit: AttributionCommit;
  previousCommittedAt: string | null;
  file: AttributionFile;
}

interface HumanRewriteEvidence {
  models: string[];
  sessionIds: string[];
  sourceText: string;
}

interface RemoveLineEvidence {
  text: string;
  match: SnapshotLineMatch | null;
  sourceAttribution: "none" | "ai" | "human";
}

export function buildCommitFileAttribution(
  input: BuildCommitFileAttributionInput,
): CommitFileAttribution | null {
  const diff = readCommitFileDiff(input.repoRoot, input.commit.sha, input.file.path);
  if (!diff) {
    return null;
  }

  const aiSnapshotLineMatches = readSnapshotLineMatches(
    input.statePaths,
    input.currentBranch,
    input.file.path,
    input.previousCommittedAt,
    input.commit.committedAt,
    "ai",
  );
  const humanSnapshotLineMatches = readSnapshotLineMatches(
    input.statePaths,
    input.currentBranch,
    input.file.path,
    input.previousCommittedAt,
    input.commit.committedAt,
    "human",
  );

  let aiLines = 0;
  let humanLines = 0;
  let unknownLines = 0;
  let removedLines = 0;
  const evidenceSummary = createEmptyEvidenceSummary();

  const hunks: AttributedDiffHunk[] = diff.hunks.map((hunk) => {
    const removeEvidence: RemoveLineEvidence[] = [];
    const pendingAdditions: Array<{ index: number; line: CommitDiffHunkLine }> = [];
    const lines: AttributedDiffLine[] = [];

    for (const line of hunk.lines) {
      if (line.kind === "context") {
        lines.push({
          ...line,
          attribution: "context",
          evidence: "none",
          models: [],
          sessionIds: [],
          sourceAttribution: "none",
          inlineSegments: [],
        });
        continue;
      }

      if (line.kind === "remove") {
        removedLines += 1;
        const sourceMatch = resolveSnapshotSourceMatch(
          hashText(line.text),
          aiSnapshotLineMatches,
          humanSnapshotLineMatches,
        );
        removeEvidence.push({
          text: line.text,
          match: sourceMatch?.sourceAttribution === "ai" ? sourceMatch.match : null,
          sourceAttribution: sourceMatch?.sourceAttribution ?? "none",
        });
        lines.push({
          ...line,
          attribution: "remove",
          evidence: "none",
          models: sourceMatch ? [...sourceMatch.match.models] : [],
          sessionIds: sourceMatch ? [...sourceMatch.match.sessionIds] : [],
          sourceAttribution: sourceMatch?.sourceAttribution ?? "none",
          inlineSegments: sourceMatch
            ? [{ text: line.text, attribution: "source" }]
            : [],
        });
        if (sourceMatch?.sourceAttribution === "ai") {
          evidenceSummary.removedAiSourceLines += 1;
        } else if (sourceMatch?.sourceAttribution === "human") {
          evidenceSummary.removedHumanSourceLines += 1;
        } else {
          evidenceSummary.removedUnknownSourceLines += 1;
        }
        continue;
      }

      pendingAdditions.push({
        index: lines.length,
        line,
      });
      lines.push({
        ...line,
        attribution: "unknown",
        evidence: "none",
        models: [],
        sessionIds: [],
        sourceAttribution: "none",
        inlineSegments: [{ text: line.text, attribution: "unknown" }],
      });
    }

    for (const pending of pendingAdditions) {
      const lineHash = hashText(pending.line.text);
      const aiMatch = aiSnapshotLineMatches.get(lineHash);

      if (aiMatch) {
        aiLines += 1;
        evidenceSummary.aiHashMatchLines += 1;
        lines[pending.index] = {
          ...pending.line,
          attribution: "ai",
          evidence: "snapshot_hash_match",
          models: [...aiMatch.models],
          sessionIds: [...aiMatch.sessionIds],
          sourceAttribution: "ai",
          inlineSegments: [{ text: pending.line.text, attribution: "ai" }],
        };
        continue;
      }

      const humanSnapshotMatch = humanSnapshotLineMatches.get(lineHash);
      if (humanSnapshotMatch) {
        humanLines += 1;
        evidenceSummary.humanSnapshotLines += 1;
        if (humanSnapshotMatch.evidenceTypes.has("manual_snapshot")) {
          evidenceSummary.humanManualSnapshotLines += 1;
        }
        if (humanSnapshotMatch.evidenceTypes.has("reconcile_snapshot")) {
          evidenceSummary.humanReconcileSnapshotLines += 1;
        }

        // If a human-authored line also appears in AI snapshots, track that it originated from AI
        const alsoAiMatch = aiSnapshotLineMatches.get(lineHash);
        const sourceAttribution = alsoAiMatch ? "ai" : "human";
        const combinedModels = new Set([...humanSnapshotMatch.models, ...(alsoAiMatch?.models ?? [])]);
        const combinedSessionIds = new Set([...humanSnapshotMatch.sessionIds, ...(alsoAiMatch?.sessionIds ?? [])]);

        lines[pending.index] = {
          ...pending.line,
          attribution: "human",
          evidence: "explicit_human_snapshot",
          models: [...combinedModels],
          sessionIds: [...combinedSessionIds],
          sourceAttribution,
          inlineSegments: [{ text: pending.line.text, attribution: "human" }],
        };
        continue;
      }

      const rewriteEvidence = findHumanRewriteEvidence(pending.line.text, removeEvidence);
      if (rewriteEvidence) {
        humanLines += 1;
        evidenceSummary.humanRewriteLines += 1;
        lines[pending.index] = {
          ...pending.line,
          attribution: "human",
          evidence: "rewrite_of_ai_line",
          models: rewriteEvidence.models,
          sessionIds: rewriteEvidence.sessionIds,
          sourceAttribution: "ai",
          inlineSegments: buildRewriteInlineSegments(rewriteEvidence.sourceText, pending.line.text),
        };
        continue;
      }

      unknownLines += 1;
      lines[pending.index] = {
        ...pending.line,
        attribution: "unknown",
        evidence: "none",
        models: [],
        sessionIds: [],
        sourceAttribution: "none",
        inlineSegments: [{ text: pending.line.text, attribution: "unknown" }],
      };
    }

    return {
      header: hunk.header,
      lines,
    };
  });

  return {
    path: input.file.path,
    patch: diff.patch,
    aiLines,
    humanLines,
    unknownLines,
    removedLines,
    evidenceSummary,
    hunks,
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

function buildRewriteInlineSegments(previousText: string, nextText: string): InlineAttributionSegment[] {
  const segments: InlineAttributionSegment[] = [];
  const changes = diffWordsWithSpace(previousText, nextText);

  for (const change of changes) {
    if (change.removed) {
      continue;
    }

    segments.push({
      text: change.value,
      attribution: change.added ? "human" : "ai",
    });
  }

  return mergeInlineSegments(segments);
}

function mergeInlineSegments(segments: InlineAttributionSegment[]): InlineAttributionSegment[] {
  const merged: InlineAttributionSegment[] = [];

  for (const segment of segments) {
    if (segment.text.length === 0) {
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous && previous.attribution === segment.attribution) {
      previous.text += segment.text;
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
}

function findHumanRewriteEvidence(
  additionText: string,
  removeEvidence: RemoveLineEvidence[],
): HumanRewriteEvidence | null {
  let bestMatch: SnapshotLineMatch | null = null;
  let bestSourceText: string | null = null;
  let bestScore = 0;

  for (const entry of removeEvidence) {
    if (!entry.match || entry.sourceAttribution !== "ai") {
      continue;
    }

    const score = similarityScore(additionText, entry.text);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry.match;
      bestSourceText = entry.text;
    }
  }

  if (!bestMatch || !bestSourceText || bestScore < HUMAN_REWRITE_SIMILARITY_THRESHOLD) {
    return null;
  }

  return {
    models: [...bestMatch.models],
    sessionIds: [...bestMatch.sessionIds],
    sourceText: bestSourceText,
  };
}

function resolveSnapshotSourceMatch(
  lineHash: string,
  aiSnapshotLineMatches: Map<string, SnapshotLineMatch>,
  humanSnapshotLineMatches: Map<string, SnapshotLineMatch>,
): { sourceAttribution: "ai" | "human"; match: SnapshotLineMatch } | null {
  const aiMatch = aiSnapshotLineMatches.get(lineHash);
  if (aiMatch) {
    return {
      sourceAttribution: "ai",
      match: aiMatch,
    };
  }

  const humanMatch = humanSnapshotLineMatches.get(lineHash);
  if (humanMatch) {
    return {
      sourceAttribution: "human",
      match: humanMatch,
    };
  }

  return null;
}

function similarityScore(left: string, right: string): number {
  const normalizedLeft = normalizeForComparison(left);
  const normalizedRight = normalizeForComparison(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return 0.9;
  }

  const leftTokens = tokenSet(normalizedLeft);
  const rightTokens = tokenSet(normalizedRight);
  const tokenScore = jaccard(leftTokens, rightTokens);
  const characterScore = diceCoefficient(normalizedLeft, normalizedRight);

  return Number(((tokenScore * 0.55) + (characterScore * 0.45)).toFixed(4));
}

function normalizeForComparison(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .split(/[^a-z0-9_\u4e00-\u9fff]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}

function diceCoefficient(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);

  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const gram of leftBigrams) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let matches = 0;
  for (const gram of rightBigrams) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      matches += 1;
      counts.set(gram, count - 1);
    }
  }

  return (2 * matches) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value: string): string[] {
  if (value.length < 2) {
    return [value];
  }

  const grams: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.push(value.slice(index, index + 2));
  }

  return grams;
}

function readSnapshotLineMatches(
  statePaths: StatePaths,
  currentBranch: string,
  relativePath: string,
  previousCommittedAt: string | null,
  committedAt: string,
  attributionSource: "ai" | "human",
): Map<string, SnapshotLineMatch> {
  if (!existsSync(statePaths.indexFile)) {
    return new Map();
  }

  const previousCommittedAtMs = toEpochMs(previousCommittedAt);
  const committedAtMs = toEpochMs(committedAt);
  const commitWindowEndMs = committedAtMs === null ? null : committedAtMs + COMMIT_TIME_TOLERANCE_MS;
  const db = new Database(statePaths.indexFile, { readonly: true });

  try {
    const rows = db.query(
      `
        SELECT
          e.model AS model,
          e.session_id AS session_id,
          e.evidence_type AS evidence_type,
          s.line_hashes_json AS line_hashes_json
        FROM normalized_trace_events e
        JOIN file_snapshots s
          ON e.snapshot_id = s.snapshot_id
        WHERE e.current_branch = ?
          AND e.relative_path = ?
          AND e.attribution_source = ?
          AND e.category IN ('file_edit', 'human_snapshot')
          AND (? IS NULL OR e.recorded_at_ms <= ?)
          AND (? IS NULL OR e.recorded_at_ms > ?)
      `,
    ).all(
      currentBranch,
      relativePath,
      attributionSource,
      commitWindowEndMs,
      commitWindowEndMs,
      previousCommittedAtMs,
      previousCommittedAtMs,
    ) as Array<{
      model: string | null;
      session_id: string | null;
      evidence_type: string | null;
      line_hashes_json: string;
    }>;

    const matches = new Map<string, SnapshotLineMatch>();

    for (const row of rows) {
      let lineHashes: string[] = [];

      try {
        const parsed = JSON.parse(row.line_hashes_json) as unknown;
        if (Array.isArray(parsed)) {
          lineHashes = parsed.filter((value): value is string => typeof value === "string");
        }
      } catch {
        continue;
      }

      for (const lineHash of lineHashes) {
        const match = matches.get(lineHash) ?? {
          models: new Set<string>(),
          sessionIds: new Set<string>(),
          evidenceTypes: new Set<string>(),
        };

        if (row.model) {
          match.models.add(row.model);
        }
        if (row.session_id) {
          match.sessionIds.add(row.session_id);
        }
        if (row.evidence_type) {
          match.evidenceTypes.add(row.evidence_type);
        }

        matches.set(lineHash, match);
      }
    }

    return matches;
  } finally {
    db.close();
  }
}

function toEpochMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
