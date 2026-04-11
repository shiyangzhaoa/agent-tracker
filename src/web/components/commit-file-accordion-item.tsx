import React, { useState } from "react";

import type { CommitCoverageFile } from "../types";
import { CommitFileDiffContent } from "./commit-file-diff-content";

function commitFileStatusLabel(file: Pick<CommitCoverageFile, "status">): string {
  if (file.status === "added") {
    return "新增";
  }

  if (file.status === "deleted") {
    return "删除";
  }

  if (file.status === "renamed") {
    return "重命名";
  }

  if (file.status === "modified") {
    return "修改";
  }

  return "变更";
}

function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "0.0%";
  }

  return `${value.toFixed(1)}%`;
}

export function CommitFileAccordionItem({
  commitSha,
  file,
}: {
  commitSha: string;
  file: CommitCoverageFile;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      className={`file-accordion-item ${expanded ? "expanded" : ""}`.trim()}
    >
      <button
        className="file-accordion-trigger"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`status-pill ${file.isIgnored ? "ignored" : file.status}`}>
          {file.isIgnored ? "已忽略" : commitFileStatusLabel(file)}
        </span>
        <span className="file-accordion-name">
          {file.previousPath ? file.previousPath + " → " + file.path : file.path}
          {!file.isIgnored && file.models.length > 0
            ? <span className="file-accordion-model">({file.models.join(", ")})</span>
            : null}
        </span>
        <div className="file-metric-chips">
          {!file.isIgnored && (
            <>
              <span className="metric-chip ratio" title={`AI 生成占比 ${formatPercent(file.aiLineCoveragePercent)}：AI 新增行 / 总新增行`}>AI 率 {formatPercent(file.aiLineCoveragePercent)}</span>
              <span className="metric-chip ai" title={`AI 生成 ${file.aiLines} 行：命中 AI 快照哈希的新增内容`}>AI {file.aiLines}</span>
              <span className="metric-chip human" title={`人工编写 ${file.humanLines} 行：命中手动标记、Reconcile 或 AI 代码改写的新增内容`}>人工 {file.humanLines}</span>
              <span className="metric-chip unknown" title={`未识别 ${file.unknownLines} 行：证据不足的新增内容`}>未识别 {file.unknownLines}</span>
              <span className="metric-chip secondary" title={`原始事件命中 ${file.observedEventCount} 条：当前文件命中的原始采集事件数`}>采集数 {file.observedEventCount}</span>
            </>
          )}
          <span className="metric-chip secondary" title={`Git 原生统计：新增 ${file.additions} 行 / 删除 ${file.deletions} 行`}>Git +{file.additions} / -{file.deletions}</span>
          <span className="accordion-chevron">{expanded ? "收起" : "展开"}</span>
        </div>
      </button>

      {expanded ? (
        <div className="file-accordion-content">
          <CommitFileDiffContent
            commitSha={commitSha}
            filePath={file.path}
            expanded={expanded}
          />
        </div>
      ) : null}
    </section>
  );
}
