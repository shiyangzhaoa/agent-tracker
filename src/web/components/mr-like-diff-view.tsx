import React from "react";

import { buildSplitDiffRows } from "../../lib/split-diff";
import type { CommitFileAttribution } from "../types";

type DiffLine = CommitFileAttribution["hunks"][number]["lines"][number];

export function MrLikeDiffView({ fileAttribution }: { fileAttribution: CommitFileAttribution }) {
  const rows = buildSplitDiffRows(fileAttribution.hunks, {
    normalizeText: normalizeDiffLineText,
  });

  const elements: React.ReactNode[] = [];
  let hunkIndex = 0;
  let lastAttrKey: string | null = null;

  rows.forEach((row, idx) => {
    if (row.kind === "hunk") {
      elements.push(
        <div key={`hunk-header-${hunkIndex++}`} className="mr-hunk-header">
          {row.header}
        </div>
      );
      lastAttrKey = null; // New hunk resets attribution grouping
      return;
    }

    // Attribution logic for the "New" side (right)
    const src = row.right?.source;
    if (src && (src.attribution === "ai" || src.attribution === "human" || src.attribution === "unknown")) {
      const currentAttrKey = [
        src.attribution,
        (src.models || []).join(","),
        src.evidence,
        src.sourceAttribution,
      ].join("|");

      if (currentAttrKey !== lastAttrKey) {
        elements.push(
          <AttributionInfoRow
            key={`attr-${row.key}`}
            attribution={src.attribution}
            models={src.models}
            evidence={src.evidence}
            sourceAttribution={src.sourceAttribution}
            sessionIds={src.sessionIds}
          />
        );
        lastAttrKey = currentAttrKey;
      }
    } else if (row.right?.kind === "context") {
      // For context lines, we might want to reset or keep the last attribution
      // Usually context lines don't carry attribution in the same way, but let's reset to be safe
      lastAttrKey = null;
    }

    elements.push(
      <div key={row.key} className="mr-split-row">
        <div className={`mr-cell ${resolveMrCellKind(row.left)}`}>
          <span className="mr-num">{row.left?.lineNumber ?? ""}</span>
          <span className="mr-mark">{row.left?.kind === "remove" ? "-" : row.left?.kind === "add" ? "+" : ""}</span>
          <span className="mr-code">{renderHighlightedCodeLine(row.left?.text ?? "", fileAttribution.path)}</span>
        </div>
        <div className={`mr-cell ${resolveMrCellKind(row.right)}`}>
          <span className="mr-num">{row.right?.lineNumber ?? ""}</span>
          <span className="mr-mark">{row.right?.kind === "add" ? "+" : row.right?.kind === "remove" ? "-" : ""}</span>
          <span className="mr-code">{renderHighlightedCodeLine(row.right?.text ?? "", fileAttribution.path)}</span>
        </div>
      </div>
    );
  });

  const addedLines = fileAttribution.aiLines + fileAttribution.humanLines + fileAttribution.unknownLines;

  return (
    <div className="mr-diff">
      <div className="mr-split-head">
        <span>变更前 (减少 {fileAttribution.removedLines} 行)</span>
        <span>变更后 (增加 {addedLines} 行)</span>
      </div>
      {elements}
    </div>
  );
}

function AttributionInfoRow({
  attribution,
  models,
  evidence,
  sourceAttribution,
  sessionIds,
}: {
  attribution: string;
  models?: string[];
  evidence?: string;
  sourceAttribution?: string;
  sessionIds?: string[];
}) {
  const isAi = attribution === "ai";
  const isHuman = attribution === "human";
  const isUnknown = attribution === "unknown";

  let toneLabel = isAi ? "AI 生成" : isHuman ? "人工编写" : isUnknown ? "未知来源" : attribution;
  if (isHuman && evidence === "rewrite_of_ai_line") {
    toneLabel = "人工改写";
  }

  const color = isAi ? "#58a6ff" : isHuman ? "#a3e635" : isUnknown ? "#fbbf24" : "#f3f4f6";
  
  const evidenceLabel = 
    evidence === "snapshot_hash_match" ? "AI 生成" : 
    evidence === "explicit_human_snapshot" ? "手动标记" : 
    evidence === "rewrite_of_ai_line" ? "基于 AI 代码改写" : 
    evidence;

  const modelText = models && models.length > 0 ? models.join(", ") : null;
  const sessionCount = sessionIds?.length || 0;

  return (
    <div className="mr-split-row" style={{ borderBottom: "none", minHeight: "auto" }}>
      <div className="mr-cell blank" style={{ borderRight: "1px solid #303030" }} />
      <div className="mr-cell" style={{ display: "block", padding: "0 12px", background: "transparent" }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 12px",
          margin: "6px 0",
          background: "#222c36",
          borderRadius: 6,
          border: "1px solid #3b4252",
          fontSize: 12,
          color: "#c9d1d9",
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
          maxWidth: "100%",
          overflowX: "auto",
          whiteSpace: "nowrap"
        }}>
          <span style={{ fontWeight: 700, fontSize: 13, color, letterSpacing: "0.5px" }}>{toneLabel}</span>
          
          {modelText && (
            <span style={{ color: "#8b949e" }}>
              AI 模型: <span style={{ color: "#c9d1d9" }}>{modelText}</span>
            </span>
          )}
          
          {evidenceLabel && (
            <span style={{ color: "#8b949e" }}>
              归因依据: <span style={{ color: "#c9d1d9" }}>{evidenceLabel}</span>
            </span>
          )}
          
          {sessionCount > 0 && (
            <span style={{ color: "#8b949e" }}>
              会话数: <span style={{ color: "#c9d1d9" }}>{sessionCount}</span>
            </span>
          )}

          {sourceAttribution && sourceAttribution !== "none" && sourceAttribution !== attribution && (
            <span style={{ color: "#8b949e" }}>
              代码原始来源: <span style={{ color: sourceAttribution === "ai" ? "#58a6ff" : "#a3e635" }}>{sourceAttribution === "ai" ? "AI 生成" : "人工编写"}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function resolveMrCellKind(cell: { kind: string } | undefined): "context" | "add" | "remove" | "blank" {
  if (!cell) {
    return "blank";
  }

  if (cell.kind === "context" || cell.kind === "add" || cell.kind === "remove") {
    return cell.kind;
  }

  return "blank";
}

function normalizeDiffLineText(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+$/g, "");
}

function renderHighlightedCodeLine(value: string, filePath: string): React.ReactNode {
  if (!value) {
    return "";
  }

  const language = inferLanguageFromPath(filePath);
  const keywordPattern = language === "toml"
    ? /\b(true|false)\b/g
    : /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|class|new|async|await|try|catch|throw|interface|type|extends|implements)\b/g;
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#.*$|\/\/.*$|\b\d+(?:\.\d+)?\b)/g;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(value)) !== null) {
    const token = match[0] ?? "";
    const start = match.index;

    if (start > cursor) {
      parts.push(renderKeywordSpan(value.slice(cursor, start), keywordPattern, parts.length));
    }

    if (token.startsWith("#") || token.startsWith("//")) {
      parts.push(<span key={`tok:${start}`} className="mr-tok-comment">{token}</span>);
    } else if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) {
      parts.push(<span key={`tok:${start}`} className="mr-tok-string">{token}</span>);
    } else {
      parts.push(<span key={`tok:${start}`} className="mr-tok-number">{token}</span>);
    }

    cursor = start + token.length;
  }

  if (cursor < value.length) {
    parts.push(renderKeywordSpan(value.slice(cursor), keywordPattern, parts.length));
  }

  return parts;
}

function renderKeywordSpan(value: string, pattern: RegExp, seed: number): React.ReactNode {
  if (!value) {
    return "";
  }

  const result: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;

  while ((match = pattern.exec(value)) !== null) {
    const token = match[0] ?? "";
    const start = match.index;

    if (start > cursor) {
      result.push(<span key={`txt:${seed}:${cursor}`}>{value.slice(cursor, start)}</span>);
    }

    result.push(<span key={`kw:${seed}:${start}`} className="mr-tok-keyword">{token}</span>);
    cursor = start + token.length;
  }

  if (cursor < value.length) {
    result.push(<span key={`txt:${seed}:tail`}>{value.slice(cursor)}</span>);
  }

  return result;
}

function inferLanguageFromPath(path: string): "toml" | "js" | "other" {
  if (path.endsWith(".toml")) {
    return "toml";
  }

  if (
    path.endsWith(".vue")
    || path.endsWith(".ts")
    || path.endsWith(".tsx")
    || path.endsWith(".js")
    || path.endsWith(".jsx")
    || path.endsWith(".json")
  ) {
    return "js";
  }

  return "other";
}
