import React, { useEffect, useState } from "react";

import { MrLikeDiffView } from "./mr-like-diff-view";
import type { CommitFileAttribution } from "../types";

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="empty compact">
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export function CommitFileDiffContent({
  commitSha,
  filePath,
  expanded,
}: {
  commitSha: string;
  filePath: string;
  expanded: boolean;
}) {
  const [fileAttribution, setFileAttribution] = useState<CommitFileAttribution | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || fileAttribution || fileError) {
      return;
    }

    let cancelled = false;
    setFileLoading(true);
    setFileError(null);

    void fetch(`/api/commit/${encodeURIComponent(commitSha)}/file?path=${encodeURIComponent(filePath)}`)
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: "请求失败" })) as { error?: string };
          throw new Error(error.error ?? "请求失败");
        }

        return response.json() as Promise<CommitFileAttribution>;
      })
      .then((payload) => {
        if (!cancelled) {
          setFileAttribution(payload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFileError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFileLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [commitSha, expanded, fileAttribution, fileError, filePath]);

  if (!expanded) {
    return null;
  }

  if (fileLoading) {
    return <EmptyState title="正在加载差异详情" description="请稍候..." />;
  }

  if (fileError) {
    return <EmptyState title="加载失败" description={fileError} />;
  }

  if (!fileAttribution) {
    return <EmptyState title="暂无差异详情" description="该文件可能是二进制文件，或者在当前范围内没有可识别的代码变更。" />;
  }

  return (
    <div className="diff-stack">
      <div className="diff-host">
        <MrLikeDiffView fileAttribution={fileAttribution} />
      </div>
    </div>
  );
}
