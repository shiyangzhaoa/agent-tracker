import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { resolve as resolvePath } from "node:path";

import { runCollectCursorInstall } from "../commands/collect-cursor-install";
import { runDoctor } from "../commands/doctor";
import { runInit } from "../commands/init";
import { captureCommandOutput } from "../lib/capture";
import type { CommitCoverageFile, CommitDataSummary } from "../lib/branch-data";
import { buildCommitFileAttribution, type CommitFileAttribution } from "../lib/line-attribution";
import { buildSplitDiffRows } from "../lib/split-diff";
import { getAppSnapshot, type AppSnapshot, type SnapshotTone } from "../lib/snapshot";
import { launchDashboardDetached, openUrl } from "../web/server";

type NavSurface = "stats" | "commits" | "dashboard" | "setup" | "health";
type AppRoute =
  | { kind: "stats" }
  | { kind: "commits" }
  | { kind: "commit-detail"; sha: string }
  | { kind: "file-detail"; sha: string; path: string }
  | { kind: "dashboard" }
  | { kind: "setup" }
  | { kind: "health" };
type ReportTone = "neutral" | "success" | "warn" | "error";

interface ReportState {
  title: string;
  tone: ReportTone;
  lines: string[];
}

interface TaskItem {
  id: string;
  label: string;
  run: () => Promise<void>;
}

const TASK_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

type InkColor = "white" | "yellow" | "red" | "gray" | "cyan" | "blue" | "green" | "black" | "magenta" | "cyanBright" | "blueBright" | "yellowBright" | "greenBright";

const PIPE_SEGMENT_THEME: {
  separator: InkColor;
  ai: InkColor;
  human: InkColor;
  unknown: InkColor;
  removed: InkColor;
  commit: InkColor;
  self: InkColor;
  teammate: InkColor;
  fileCoverage: InkColor;
  model: InkColor;
  session: InkColor;
  raw: InkColor;
  normalized: InkColor;
  snapshot: InkColor;
  manual: InkColor;
  reconcile: InkColor;
  ahead: InkColor;
  behind: InkColor;
  dirty: InkColor;
  branch: InkColor;
  target: InkColor;
  config: InkColor;
  storage: InkColor;
  cursor: InkColor;
  default: InkColor;
} = {
  separator: "gray",
  ai: "cyanBright",
  human: "blueBright",
  unknown: "yellowBright",
  removed: "red",
  commit: "greenBright",
  self: "green",
  teammate: "yellow",
  fileCoverage: "cyan",
  model: "magenta",
  session: "blue",
  raw: "yellow",
  normalized: "cyan",
  snapshot: "green",
  manual: "blue",
  reconcile: "yellowBright",
  ahead: "greenBright",
  behind: "red",
  dirty: "yellow",
  branch: "cyan",
  target: "blue",
  config: "green",
  storage: "cyan",
  cursor: "magenta",
  default: "white",
};

const NAV_ORDER: NavSurface[] = ["stats", "commits", "dashboard", "setup", "health"];
const NAV_LABELS: Record<NavSurface, string> = {
  stats: "统计",
  commits: "提交",
  dashboard: "仪表盘",
  setup: "设置",
  health: "健康",
};

export async function renderApp(cwd: string): Promise<void> {
  const instance = render(<AgentTrackerApp cwd={cwd} />, {
    alternateScreen: true,
  });

  await instance.waitUntilExit();
}

function AgentTrackerApp({ cwd }: { cwd: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [route, setRoute] = useState<AppRoute>({ kind: "stats" });
  const [selectedCommitIndex, setSelectedCommitIndex] = useState(0);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);
  const [showContextLines, setShowContextLines] = useState(true);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(true);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [runningTaskFrame, setRunningTaskFrame] = useState(0);
  const [lastReport, setLastReport] = useState<ReportState | null>(null);
  const [lastDashboardUrl, setLastDashboardUrl] = useState<string | null>(null);
  const lastCommitForFileSelectionRef = useRef<string | null>(null);

  const surface = routeToSurface(route);
  const rows = stdout?.rows ?? 24;

  const refreshSnapshot = async () => {
    setLoadingSnapshot(true);

    try {
      const nextSnapshot = await getAppSnapshot(cwd);
      setSnapshot(nextSnapshot);
      setLastDashboardUrl(`http://127.0.0.1:${nextSnapshot.webPort ?? 3487}`);
      return nextSnapshot;
    } finally {
      setLoadingSnapshot(false);
    }
  };

  useEffect(() => {
    void refreshSnapshot();
  }, [cwd]);

  useEffect(() => {
    if (!runningTaskId) {
      setRunningTaskFrame(0);
      return;
    }

    const interval = setInterval(() => {
      setRunningTaskFrame((current) => (current + 1) % TASK_SPINNER_FRAMES.length);
    }, 100);

    return () => {
      clearInterval(interval);
    };
  }, [runningTaskId]);

  const commitTimeline = getCommitTimeline(snapshot);
  const selectedCommit = commitTimeline[selectedCommitIndex] ?? null;
  const selectedFile = selectedCommit?.files[selectedFileIndex] ?? null;
  const setupTasks = useMemo(() => buildSetupTasks(snapshot, cwd, setLastReport, refreshSnapshot, setRunningTaskId), [cwd, snapshot]);
  const healthTasks = useMemo(() => buildHealthTasks(snapshot, cwd, setLastReport, refreshSnapshot, setRunningTaskId), [cwd, snapshot]);
  const dashboardTasks = useMemo(
    () => buildDashboardTasks(cwd, snapshot, setLastReport, setLastDashboardUrl, setRunningTaskId),
    [cwd, snapshot],
  );
  const tasks = surface === "setup"
    ? setupTasks
    : surface === "health"
      ? healthTasks
      : surface === "dashboard"
        ? dashboardTasks
        : [];

  useEffect(() => {
    if (selectedCommitIndex >= commitTimeline.length) {
      setSelectedCommitIndex(Math.max(0, commitTimeline.length - 1));
    }
  }, [commitTimeline.length, selectedCommitIndex]);

  useEffect(() => {
    if (!selectedCommit) {
      setSelectedFileIndex(0);
      return;
    }

    if (selectedFileIndex >= selectedCommit.files.length) {
      setSelectedFileIndex(Math.max(0, selectedCommit.files.length - 1));
    }
  }, [selectedCommit, selectedFileIndex]);

  useEffect(() => {
    if (route.kind !== "commit-detail" && route.kind !== "file-detail") {
      lastCommitForFileSelectionRef.current = null;
      return;
    }

    if (!selectedCommit) {
      return;
    }

    if (lastCommitForFileSelectionRef.current === selectedCommit.sha) {
      return;
    }

    lastCommitForFileSelectionRef.current = selectedCommit.sha;
    setSelectedFileIndex(getPreferredFileIndex(selectedCommit.files));
  }, [route.kind, selectedCommit]);

  useEffect(() => {
    if (route.kind === "commit-detail" || route.kind === "file-detail") {
      const nextIndex = commitTimeline.findIndex((commit) => commit.sha === route.sha);
      if (nextIndex >= 0 && nextIndex !== selectedCommitIndex) {
        setSelectedCommitIndex(nextIndex);
      }
    }
  }, [commitTimeline, route, selectedCommitIndex]);

  useEffect(() => {
    if (route.kind !== "file-detail") {
      return;
    }

    const commit = commitTimeline.find((entry) => entry.sha === route.sha);
    if (!commit) {
      setRoute({ kind: "commits" });
      return;
    }

    const nextFileIndex = commit.files.findIndex((file) => file.path === route.path);
    if (nextFileIndex >= 0 && nextFileIndex !== selectedFileIndex) {
      setSelectedFileIndex(nextFileIndex);
    }
  }, [commitTimeline, route, selectedFileIndex]);

  useEffect(() => {
    if (selectedTaskIndex >= tasks.length) {
      setSelectedTaskIndex(0);
    }
  }, [selectedTaskIndex, tasks.length]);

  const fileAttribution = useMemo(
    () => buildSelectedFileAttribution(route, snapshot, selectedCommitIndex, selectedFileIndex),
    [route, snapshot, selectedCommitIndex, selectedFileIndex],
  );

  const infoLines = compactLines(
    buildInfoLines(snapshot, route, selectedCommit, selectedFile, lastReport, runningTaskId, runningTaskFrame, loadingSnapshot),
    3,
  );
  const detailLineBudget = Math.max(10, rows - 12);
  const fileDetailScrollMax = useMemo(
    () => getFileDetailScrollMax(snapshot, selectedCommit, selectedFile, fileAttribution, detailLineBudget, showContextLines),
    [detailLineBudget, fileAttribution, selectedCommit, selectedFile, showContextLines, snapshot],
  );
  const detailLines = buildDetailLines({
    route,
    snapshot,
    selectedCommitIndex,
    selectedFileIndex,
    fileAttribution,
    lastDashboardUrl,
    tasks,
    selectedTaskIndex,
    detailLineBudget,
    runningTaskId,
    runningTaskFrame,
  });

  useEffect(() => {
    setDetailScrollOffset(0);
  }, [route.kind, selectedCommit?.sha, selectedFile?.path]);

  useEffect(() => {
    setDetailScrollOffset((current) => Math.min(current, fileDetailScrollMax));
  }, [fileDetailScrollMax]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }

    if (runningTaskId) {
      return;
    }

    if (input === "1" || input === "2" || input === "3" || input === "4" || input === "5") {
      const nextSurface = NAV_ORDER[Number.parseInt(input, 10) - 1];
      if (nextSurface) {
        setRoute(navSurfaceToRoute(nextSurface));
        setSelectedTaskIndex(0);
      }
      return;
    }

    if (key.leftArrow) {
      cycleSurface(-1, surface, setRoute);
      setSelectedTaskIndex(0);
      return;
    }

    if (key.rightArrow) {
      cycleSurface(1, surface, setRoute);
      setSelectedTaskIndex(0);
      return;
    }

    if (input === "r") {
      void runRefresh(refreshSnapshot, setLastReport, setRunningTaskId);
      return;
    }

    if (route.kind === "file-detail" && selectedCommit && (input === "[" || input === "]")) {
      const nextIndex = input === "["
        ? Math.max(selectedFileIndex - 1, 0)
        : Math.min(selectedFileIndex + 1, Math.max(0, selectedCommit.files.length - 1));
      const nextFile = selectedCommit.files[nextIndex];

      if (nextFile) {
        setSelectedFileIndex(nextIndex);
        setRoute({ kind: "file-detail", sha: selectedCommit.sha, path: nextFile.path });
      }
      return;
    }

    if (route.kind === "file-detail" && input === "c") {
      setShowContextLines((current) => !current);
      setDetailScrollOffset(0);
      return;
    }

    if (key.escape || key.backspace || input === "h") {
      if (route.kind === "file-detail" && selectedCommit) {
        setRoute({ kind: "commit-detail", sha: selectedCommit.sha });
        return;
      }

      if (route.kind === "commit-detail") {
        setRoute({ kind: "commits" });
        return;
      }
    }

    if (input === "j" || key.downArrow) {
      if (route.kind === "file-detail") {
        setDetailScrollOffset((current) => Math.min(current + 1, fileDetailScrollMax));
        return;
      }

      if (surface === "stats" && commitTimeline.length > 0) {
        setSelectedCommitIndex((current) => Math.min(current + 1, Math.max(0, commitTimeline.length - 1)));
        return;
      }

      if (route.kind === "commits") {
        setSelectedCommitIndex((current) => Math.min(current + 1, Math.max(0, commitTimeline.length - 1)));
        return;
      }

      if (route.kind === "commit-detail" && selectedCommit) {
        setSelectedFileIndex((current) => Math.min(current + 1, Math.max(0, selectedCommit.files.length - 1)));
        return;
      }

      if (tasks.length > 0) {
        setSelectedTaskIndex((current) => Math.min(current + 1, Math.max(0, tasks.length - 1)));
      }
      return;
    }

    if (input === "k" || key.upArrow) {
      if (route.kind === "file-detail") {
        setDetailScrollOffset((current) => Math.max(current - 1, 0));
        return;
      }

      if (surface === "stats" && commitTimeline.length > 0) {
        setSelectedCommitIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (route.kind === "commits") {
        setSelectedCommitIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (route.kind === "commit-detail") {
        setSelectedFileIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (tasks.length > 0) {
        setSelectedTaskIndex((current) => Math.max(current - 1, 0));
      }
      return;
    }

    if (key.return) {
      if (route.kind === "stats" && selectedCommit) {
        setRoute({ kind: "commit-detail", sha: selectedCommit.sha });
        return;
      }

      if (route.kind === "commits" && selectedCommit) {
        setRoute({ kind: "commit-detail", sha: selectedCommit.sha });
        return;
      }

      if (route.kind === "commit-detail" && selectedCommit && selectedFile) {
        setRoute({ kind: "file-detail", sha: selectedCommit.sha, path: selectedFile.path });
        return;
      }

      const selectedTask = tasks[selectedTaskIndex];
      if (selectedTask) {
        void selectedTask.run();
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Section title="信息" borderColor={toneToColor(snapshot?.tone ?? "warn")}>
        <SummaryLines lines={infoLines} tone={snapshot?.tone ?? "warn"} />
      </Section>

      <Box marginTop={1}>
        <Section title={getSurfaceTitle(route)} borderColor="blue" minHeight={detailLineBudget + 2}>
          {route.kind === "file-detail" ? (
            <FileDetailContent
              snapshot={snapshot}
              commit={selectedCommit}
              file={selectedFile}
              fileAttribution={fileAttribution}
              detailLineBudget={detailLineBudget}
              detailScrollOffset={detailScrollOffset}
              showContextLines={showContextLines}
            />
          ) : (
            <SummaryLines lines={compactLines(detailLines, detailLineBudget)} tone={snapshot?.tone ?? "warn"} />
          )}
        </Section>
      </Box>

      <Box marginTop={1}>
        <Section title="导航" borderColor="cyan">
          <HorizontalNav surface={surface} />
        </Section>
      </Box>

      <Box marginTop={1}>
        <Section title="快捷键" borderColor="gray">
          <Text color="gray">
            {buildShortcutLine(route, tasks.length, showContextLines)}
          </Text>
        </Section>
      </Box>
    </Box>
  );
}

function Section({
  title,
  borderColor,
  minHeight,
  children,
}: {
  title: string;
  borderColor: "green" | "yellow" | "red" | "blue" | "cyan" | "gray";
  minHeight?: number;
  children: React.ReactNode;
}) {
  return (
    <Box
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      minHeight={minHeight}
    >
      <Text color={sectionTitleColor(borderColor)}>{title}</Text>
      {children}
    </Box>
  );
}

function SummaryLines({
  lines,
  tone,
}: {
  lines: string[];
  tone: SnapshotTone;
}) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} color={summaryLineColor(tone, line)}>
          {renderPipeColoredLine(line, summaryLineColor(tone, line))}
        </Text>
      ))}
    </Box>
  );
}

function renderPipeColoredLine(line: string, fallbackColor: InkColor): React.ReactNode {
  if (!line.includes(" | ")) {
    return line;
  }

  const segments = line.split(" | ");

  return segments.flatMap((segment, index) => {
    const output: React.ReactNode[] = [
      <Text key={`seg:${index}`} color={pipeSegmentColor(segment, fallbackColor)}>
        {segment}
      </Text>,
    ];

    if (index < segments.length - 1) {
      output.push(
        <Text key={`sep:${index}`} color={PIPE_SEGMENT_THEME.separator}>
          {" | "}
        </Text>,
      );
    }

    return output;
  });
}

function pipeSegmentColor(segment: string, fallbackColor: InkColor): InkColor {
  const normalized = segment.replace(/^>\s*/, "").trim().toLowerCase();

  if (normalized.startsWith("ai ") || normalized.startsWith("ai占比") || /\bai\s+\d/.test(normalized)) {
    return PIPE_SEGMENT_THEME.ai;
  }

  if (normalized.startsWith("h ") || normalized.startsWith("human") || /\bh\s+\d/.test(normalized)) {
    return PIPE_SEGMENT_THEME.human;
  }

  if (normalized.startsWith("u ") || normalized.startsWith("unknown") || /\bu\s+\d/.test(normalized)) {
    return PIPE_SEGMENT_THEME.unknown;
  }

  if (normalized.startsWith("删除") || normalized.startsWith("git删除")) {
    return PIPE_SEGMENT_THEME.removed;
  }

  if (normalized.startsWith("提交 ")) {
    return PIPE_SEGMENT_THEME.commit;
  }

  if (normalized.startsWith("本人 ")) {
    return PIPE_SEGMENT_THEME.self;
  }

  if (normalized.startsWith("团队 ")) {
    return PIPE_SEGMENT_THEME.teammate;
  }

  if (normalized.startsWith("文件覆盖") || normalized.startsWith("文件 ") || normalized.startsWith("涉及文件 ")) {
    return PIPE_SEGMENT_THEME.fileCoverage;
  }

  if (normalized.startsWith("ai 模型 ")) {
    return PIPE_SEGMENT_THEME.model;
  }

  if (normalized.startsWith("会话 ") || normalized.startsWith("会话数 ")) {
    return PIPE_SEGMENT_THEME.session;
  }

  if (normalized.startsWith("raw ") || normalized.startsWith("采集事件 ") || normalized.startsWith("采集命中 ")) {
    return PIPE_SEGMENT_THEME.raw;
  }

  if (normalized.startsWith("normalized ")) {
    return PIPE_SEGMENT_THEME.normalized;
  }

  if (normalized.startsWith("snapshots ")) {
    return PIPE_SEGMENT_THEME.snapshot;
  }

  if (normalized.startsWith("人工 ")) {
    return PIPE_SEGMENT_THEME.manual;
  }

  if (normalized.startsWith("reconcile ")) {
    return PIPE_SEGMENT_THEME.reconcile;
  }

  if (normalized.startsWith("领先 ")) {
    return PIPE_SEGMENT_THEME.ahead;
  }

  if (normalized.startsWith("落后 ")) {
    return PIPE_SEGMENT_THEME.behind;
  }

  if (normalized.startsWith("工作区 ")) {
    return PIPE_SEGMENT_THEME.dirty;
  }

  if (normalized.startsWith("当前分支 ")) {
    return PIPE_SEGMENT_THEME.branch;
  }

  if (normalized.startsWith("目标 ")) {
    return PIPE_SEGMENT_THEME.target;
  }

  if (normalized.startsWith("配置 ")) {
    return PIPE_SEGMENT_THEME.config;
  }

  if (normalized.startsWith("状态目录 ")) {
    return PIPE_SEGMENT_THEME.storage;
  }

  if (normalized.startsWith("cursor ")) {
    return PIPE_SEGMENT_THEME.cursor;
  }

  return fallbackColor === "white" ? PIPE_SEGMENT_THEME.default : fallbackColor;
}

function FileDetailContent({
  snapshot,
  commit,
  file,
  fileAttribution,
  detailLineBudget,
  detailScrollOffset,
  showContextLines,
}: {
  snapshot: AppSnapshot | null;
  commit: CommitDataSummary | null;
  file: CommitCoverageFile | null;
  fileAttribution: CommitFileAttribution | null;
  detailLineBudget: number;
  detailScrollOffset: number;
  showContextLines: boolean;
}) {
  if (!snapshot?.available || !snapshot.branchData || !commit || !file) {
    return (
      <SummaryLines lines={["当前还没有可展示的文件详情。"]} tone={snapshot?.tone ?? "warn"} />
    );
  }

  if (!fileAttribution) {
    return (
      <SummaryLines
        lines={[
          `${commit.shortSha} ${commit.subject}`,
          file.path,
          "当前文件还没有可展示的 diff。",
        ]}
        tone={snapshot.tone}
      />
    );
  }

  const headerLines = buildFileDetailHeaderLines(commit, file, fileAttribution, showContextLines);
  const detailWindow = applyDetailWindow(
    buildFileDetailEntries(fileAttribution, showContextLines),
    Math.max(4, detailLineBudget - headerLines.length),
    detailScrollOffset,
  );

  return (
    <Box flexDirection="column">
      {headerLines.map((line, index) => (
        <Text key={`header:${index}`} color={summaryLineColor(snapshot.tone, line)}>
          {renderPipeColoredLine(line, summaryLineColor(snapshot.tone, line))}
        </Text>
      ))}

      <Box marginTop={1} marginBottom={1} flexDirection="row">
        <Box width="50%">
          <Text color="gray">变更前 (-{fileAttribution.removedLines})</Text>
        </Box>
        <Box width="50%">
          <Text color="gray">变更后 (+{fileAttribution.aiLines + fileAttribution.humanLines + fileAttribution.unknownLines})</Text>
        </Box>
      </Box>

      {detailWindow.hasOverflowAbove ? (
        <Text color="gray">↑ 上方还有 {detailWindow.remainingAbove} 行</Text>
      ) : null}

      {detailWindow.visibleEntries.map((entry, index) => (
        entry.kind === "hunk" ? (
          <Text key={`hunk:${entry.header}:${index}`} color="blueBright">
            {entry.header}
          </Text>
        ) : (
          <Box key={`row:${entry.left?.oldLineNumber ?? "-"}:${entry.right?.newLineNumber ?? "-"}:${index}`} flexDirection="row">
            <Box width="50%">
              <SplitDiffCell line={entry.left} side="old" filePath={file.path} />
            </Box>
            <Box width="50%">
              <SplitDiffCell line={entry.right} side="new" filePath={file.path} />
            </Box>
          </Box>
        )
      ))}

      {detailWindow.hasOverflowBelow ? (
        <Text color="gray">↓ 下方还有 {detailWindow.remainingBelow} 行</Text>
      ) : null}
    </Box>
  );
}

function AttributionBadge({
  line,
}: {
  line: CommitFileAttribution["hunks"][number]["lines"][number];
}) {
  if (line.kind === "context") {
    return null;
  }

  if (line.kind === "remove") {
    const tone = line.sourceAttribution === "ai"
      ? "gray"
      : line.sourceAttribution === "human"
        ? "blue"
        : "white";
    const label = line.sourceAttribution === "ai"
      ? "旧AI删"
      : line.sourceAttribution === "human"
        ? "旧H删"
        : "旧行删";
    return (
      <Text color="black" backgroundColor={tone}>
        {" "}{label}{" "}
      </Text>
    );
  }

  const label = line.attribution === "ai"
    ? "AI新"
    : line.attribution === "human"
      ? "H新"
      : "U新";
  const backgroundColor = line.attribution === "ai"
    ? "cyan"
    : line.attribution === "human"
      ? "blue"
      : "yellow";
  const color = line.attribution === "unknown" ? "black" : "white";

  return (
    <Text color={color} backgroundColor={backgroundColor}>
      {" "}{label}{" "}
    </Text>
  );
}

function InlineSegmentsText({
  line,
  filePath,
}: {
  line: CommitFileAttribution["hunks"][number]["lines"][number];
  filePath: string;
}) {
  const language = inferTuiLanguageFromPath(filePath);
  const value = line.text;

  if (!value) {
    return <Text color="gray">·</Text>;
  }

  if (line.kind === "add" && line.inlineSegments.length > 0) {
    return (
      <>
        {line.inlineSegments.map((segment, index) => (
          <React.Fragment key={`${line.newLineNumber ?? "?"}:${index}:${segment.attribution}`}>
            {renderSyntaxHighlightedText(
              segment.text,
              language,
              inlineSegmentColor(segment.attribution),
              inlineSegmentBackground(segment.attribution),
              `seg:${index}`,
            )}
          </React.Fragment>
        ))}
      </>
    );
  }

  const removeBackground = line.kind === "remove"
    ? line.sourceAttribution === "ai"
      ? "gray"
      : line.sourceAttribution === "human"
        ? "blue"
        : undefined
    : undefined;

  return (
    <>
      {renderSyntaxHighlightedText(
        value,
        language,
        removeBackground ? "black" : "white",
        removeBackground,
        "line",
      )}
    </>
  );
}

function renderKeywordTokenText(
  value: string,
  pattern: RegExp,
  baseTextColor: InkColor,
  backgroundColor: InkColor | undefined,
  seed: number,
): React.ReactNode[] {
  if (!value) {
    return [];
  }

  const result: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;

  while ((match = pattern.exec(value)) !== null) {
    const token = match[0] ?? "";
    const start = match.index;

    if (start > cursor) {
      result.push(
        <Text key={`txt:${seed}:${cursor}`} color={baseTextColor} backgroundColor={backgroundColor}>
          {value.slice(cursor, start)}
        </Text>,
      );
    }

    result.push(
      <Text key={`kw:${seed}:${start}`} color="cyanBright" backgroundColor={backgroundColor}>
        {token}
      </Text>,
    );

    cursor = start + token.length;
  }

  if (cursor < value.length) {
    result.push(
      <Text key={`txt:${seed}:tail`} color={baseTextColor} backgroundColor={backgroundColor}>
        {value.slice(cursor)}
      </Text>,
    );
  }

  return result;
}

function renderSyntaxHighlightedText(
  value: string,
  language: "toml" | "js" | "markdown" | "other",
  baseTextColor: InkColor,
  backgroundColor: InkColor | undefined,
  seed: string,
): React.ReactNode[] {
  if (!value) {
    return [];
  }

  const keywordPattern = language === "toml"
    ? /\b(true|false)\b/g
    : language === "markdown"
      ? /$^/
      : /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|class|new|async|await|try|catch|throw|interface|type|extends|implements)\b/g;
  const tokenPattern = language === "markdown"
    ? /(\[[^\]]+\]\([^\)]+\)|`[^`]+`|^#{1,6}\s+|^\s*[-*+]\s+)/g
    : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#.*$|\/\/.*$|\b\d+(?:\.\d+)?\b)/g;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  tokenPattern.lastIndex = 0;

  while ((match = tokenPattern.exec(value)) !== null) {
    const token = match[0] ?? "";
    const start = match.index;

    if (start > cursor) {
      parts.push(...renderKeywordTokenText(value.slice(cursor, start), keywordPattern, baseTextColor, backgroundColor, parts.length));
    }

    if (language === "markdown" && /^#{1,6}\s+$/.test(token)) {
      parts.push(<Text key={`${seed}:tok:${start}`} color="cyanBright" backgroundColor={backgroundColor}>{token}</Text>);
    } else if (language === "markdown" && /^\s*[-*+]\s+$/.test(token)) {
      parts.push(<Text key={`${seed}:tok:${start}`} color="cyanBright" backgroundColor={backgroundColor}>{token}</Text>);
    } else if (language === "markdown" && token.startsWith("[`") === false && token.startsWith("[") && token.includes("](")) {
      parts.push(<Text key={`${seed}:tok:${start}`} color="magenta" backgroundColor={backgroundColor}>{token}</Text>);
    } else if (token.startsWith("#") || token.startsWith("//")) {
      parts.push(<Text key={`${seed}:tok:${start}`} color="gray" backgroundColor={backgroundColor}>{token}</Text>);
    } else if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) {
      parts.push(<Text key={`${seed}:tok:${start}`} color="greenBright" backgroundColor={backgroundColor}>{token}</Text>);
    } else {
      parts.push(<Text key={`${seed}:tok:${start}`} color="yellowBright" backgroundColor={backgroundColor}>{token}</Text>);
    }

    cursor = start + token.length;
  }

  if (cursor < value.length) {
    parts.push(...renderKeywordTokenText(value.slice(cursor), keywordPattern, baseTextColor, backgroundColor, parts.length));
  }

  return parts;
}

function inferTuiLanguageFromPath(path: string): "toml" | "js" | "markdown" | "other" {
  if (path.endsWith(".toml")) {
    return "toml";
  }

  if (path.endsWith(".md") || path.endsWith(".mdx")) {
    return "markdown";
  }

  if (
    path.endsWith(".ts")
    || path.endsWith(".tsx")
    || path.endsWith(".js")
    || path.endsWith(".jsx")
    || path.endsWith(".json")
  ) {
    return "js";
  }

  return "other";
}

function HorizontalNav({ surface }: { surface: NavSurface }) {
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {NAV_ORDER.map((item, index) => {
        const active = item === surface;
        return (
          <Text
            key={item}
            color={active ? "black" : "white"}
            backgroundColor={active ? "cyan" : undefined}
          >
            {" "}{index + 1}.{NAV_LABELS[item]}{" "}
          </Text>
        );
      })}
    </Box>
  );
}

function buildInfoLines(
  snapshot: AppSnapshot | null,
  route: AppRoute,
  selectedCommit: CommitDataSummary | null,
  selectedFile: CommitCoverageFile | null,
  lastReport: ReportState | null,
  runningTaskId: string | null,
  runningTaskFrame: number,
  loadingSnapshot: boolean,
): string[] {
  if (!snapshot?.available) {
    return [
      "agent-tracker",
      snapshot?.summary ?? "当前还没有可展示的数据。",
      ...(snapshot?.issues.slice(0, 1) ?? []),
    ];
  }

  const lines = [
    [
      "agent-tracker",
      toneToLabel(snapshot.tone),
      NAV_LABELS[routeToSurface(route)],
      loadingSnapshot ? "刷新中" : null,
      runningTaskId ? `${spinnerFrame(runningTaskFrame)} 执行 ${runningTaskId}` : null,
    ].filter(Boolean).join(" | "),
    [
      `${snapshot.sourceBranch ?? "未知"} -> ${snapshot.targetBranch ?? "未知"}`,
      `${snapshot.branchData?.commitCount ?? 0} 提交`,
      `AI ${formatPercent(snapshot.branchData?.aiLineCoveragePercent)}`,
      `Human ${formatPercent(snapshot.branchData?.humanLineCoveragePercent)}`,
      `Unknown ${formatPercent(snapshot.branchData?.unknownLineCoveragePercent)}`,
    ].join(" | "),
  ];

  if (route.kind === "commit-detail" || route.kind === "file-detail") {
    lines.push(
      [
        selectedCommit ? `${selectedCommit.shortSha} ${selectedCommit.subject}` : null,
        selectedFile?.path ?? null,
      ].filter(Boolean).join(" | "),
    );
  } else if (lastReport) {
    lines.push([lastReport.title, ...lastReport.lines].slice(0, 2).join(" | "));
  } else if (snapshot.issues.length > 0) {
    lines.push(snapshot.issues[0] ?? "");
  }

  return lines.filter((line) => line.trim().length > 0);
}

function buildDetailLines(input: {
  route: AppRoute;
  snapshot: AppSnapshot | null;
  selectedCommitIndex: number;
  selectedFileIndex: number;
  fileAttribution: CommitFileAttribution | null;
  lastDashboardUrl: string | null;
  tasks: TaskItem[];
  selectedTaskIndex: number;
  detailLineBudget: number;
  runningTaskId: string | null;
  runningTaskFrame: number;
}): string[] {
  const {
    route,
    snapshot,
    selectedCommitIndex,
    selectedFileIndex,
    fileAttribution,
    lastDashboardUrl,
    tasks,
    selectedTaskIndex,
    detailLineBudget,
    runningTaskId,
    runningTaskFrame,
  } = input;

  if (route.kind === "stats") {
    return buildStatsLines(snapshot, selectedCommitIndex, detailLineBudget);
  }

  if (route.kind === "commits") {
    return buildCommitListLines(snapshot, selectedCommitIndex, detailLineBudget);
  }

  if (route.kind === "commit-detail") {
    return buildCommitDetailLines(snapshot, selectedCommitIndex, selectedFileIndex, detailLineBudget);
  }

  if (route.kind === "file-detail") {
    return buildFileDetailLines(snapshot, selectedCommitIndex, selectedFileIndex, fileAttribution, detailLineBudget);
  }

  if (route.kind === "dashboard") {
    return buildDashboardLines(snapshot, lastDashboardUrl, tasks, selectedTaskIndex, runningTaskId, runningTaskFrame);
  }

  if (route.kind === "setup") {
    return buildTaskLines(snapshot, tasks, selectedTaskIndex, "当前仓库", runningTaskId, runningTaskFrame);
  }

  return buildHealthLines(snapshot, tasks, selectedTaskIndex, runningTaskId, runningTaskFrame);
}

function buildStatsLines(
  snapshot: AppSnapshot | null,
  selectedCommitIndex: number,
  detailLineBudget: number,
): string[] {
  if (!snapshot) {
    return ["准备统计中…"];
  }

  if (!snapshot.available || !snapshot.branchData) {
    return [snapshot.summary, ...snapshot.issues];
  }

  const branch = snapshot.branchData;
  const timeline = getCommitTimeline(snapshot);
  const selectedCommit = timeline[selectedCommitIndex] ?? null;
  const lines = [
    `范围 ${branch.sourceBranch} -> ${branch.targetBranch}`,
    `提交 ${branch.commitCount} | 本人 ${branch.selfCommitCount} | 团队 ${branch.teammateCommitCount}`,
    `AI 生成 ${branch.aiLines} | 人工编写 ${branch.humanLines} | 未识别 ${branch.unknownLines}`,
    `AI 占比 ${formatPercent(branch.aiLineCoveragePercent)} | 人工占比 ${formatPercent(branch.humanLineCoveragePercent)} | 文件覆盖 ${formatPercent(branch.observedFileCoveragePercent)}`,
    `新增 ${branch.additions} | 删除 ${branch.deletions}`,
    `模型 ${branch.models.join(", ") || "无"} | 会话 ${branch.sessionIds.length} | 采集事件 ${branch.rawTraceEventsConsidered}`,
    "",
    "最近提交",
  ];

  if (timeline.length === 0) {
    lines.push("当前范围内还没有新增 commit。");
    return lines;
  }

  const available = Math.max(4, detailLineBudget - lines.length);
  for (const commit of windowAround(timeline, selectedCommitIndex, available)) {
    const marker = commit.sha === selectedCommit?.sha ? ">" : " ";
    lines.push(`${marker} ${formatCommitRow(commit)}`);
  }

  return lines;
}

function buildCommitListLines(
  snapshot: AppSnapshot | null,
  selectedCommitIndex: number,
  detailLineBudget: number,
): string[] {
  if (!snapshot?.available || !snapshot.branchData) {
    return ["当前还没有可展示的提交。"];
  }

  const timeline = getCommitTimeline(snapshot);
  if (timeline.length === 0) {
    return ["当前范围内还没有新增 commit。"];
  }

  const selectedCommit = timeline[selectedCommitIndex] ?? null;
  const header = selectedCommit
    ? [
      "当前选中提交",
      `${selectedCommit.shortSha} ${selectedCommit.subject}`,
      `${selectedCommit.authorName} | AI ${formatPercent(selectedCommit.aiLineCoveragePercent)} | 人工 ${formatPercent(selectedCommit.humanLineCoveragePercent)} | 未识别 ${formatPercent(selectedCommit.unknownLineCoveragePercent)}`,
      "",
    ]
    : ["提交列表", ""];

  const available = Math.max(6, detailLineBudget - header.length);
  const windowed = windowAround(timeline, selectedCommitIndex, available);

  return [
    ...header,
    ...windowed.map((commit) => {
      const marker = commit.sha === selectedCommit?.sha ? ">" : " ";
      return `${marker} ${formatCommitRow(commit)}`;
    }),
  ];
}

function buildCommitDetailLines(
  snapshot: AppSnapshot | null,
  selectedCommitIndex: number,
  selectedFileIndex: number,
  detailLineBudget: number,
): string[] {
  if (!snapshot?.available || !snapshot.branchData) {
    return ["当前还没有可展示的提交详情。"];
  }

  const timeline = getCommitTimeline(snapshot);
  const commit = timeline[selectedCommitIndex] ?? null;
  if (!commit) {
    return ["当前范围内还没有新增 commit。"];
  }

  const lines = [
    `${commit.shortSha} ${commit.subject}`,
    `${commit.authorName} <${commit.authorEmail}>`,
    `${commit.committedAt}`,
    `AI 生成 ${commit.aiLines} | 人工编写 ${commit.humanLines} | 未识别 ${commit.unknownLines}`,
    `AI 占比 ${formatPercent(commit.aiLineCoveragePercent)} | 人工占比 ${formatPercent(commit.humanLineCoveragePercent)} | 涉及文件 ${commit.filesChanged}`,
    `采集命中 ${commit.observedCursorEventCount} 事件 | Cursor文件 ${commit.observedAiFiles} | 命中新增侧 ${commit.observedAiAdditions} 行`,
    `AI 生成依据 ${commit.evidenceSummary.aiHashMatchLines} | 人工快照 ${commit.evidenceSummary.humanSnapshotLines} | 基于 AI 代码改写 ${commit.evidenceSummary.humanRewriteLines}`,
    `手动标记 ${commit.evidenceSummary.humanManualSnapshotLines} | 自动矫正 ${commit.evidenceSummary.humanReconcileSnapshotLines}`,
    `新增 ${commit.additions} | 删除 ${commit.deletions}`,
    "归因依据 AI=实时快照哈希匹配 | 人工=手动标记/自动矫正/代码改写 | 未识别=证据不足",
    `AI 模型 ${commit.models.join(", ") || "无"} | 会话数 ${commit.sessionIds.length}`,
    "",
    "变更文件",
  ];

  if (commit.observedCursorEventCount === 0) {
    lines.splice(9, 0, "诊断提示：此提交未命中 Cursor 采集事件，证据不足时会先标记为未识别");
  }

  const available = Math.max(5, detailLineBudget - lines.length);
  const windowedFiles = windowAround(commit.files, selectedFileIndex, available);
  for (const file of windowedFiles) {
    const marker = file.path === commit.files[selectedFileIndex]?.path ? ">" : " ";
    lines.push(`${marker} ${formatCommitFileLine(file)}`);
  }

  return lines;
}

function buildFileDetailLines(
  snapshot: AppSnapshot | null,
  selectedCommitIndex: number,
  selectedFileIndex: number,
  fileAttribution: CommitFileAttribution | null,
  detailLineBudget: number,
): string[] {
  if (!snapshot?.available || !snapshot.branchData) {
    return ["当前还没有可展示的文件详情。"];
  }

  const timeline = getCommitTimeline(snapshot);
  const commit = timeline[selectedCommitIndex] ?? null;
  const file = commit?.files[selectedFileIndex] ?? null;
  if (!commit || !file) {
    return ["当前还没有可展示的文件详情。"];
  }

  if (!fileAttribution) {
    return [
      `${commit.shortSha} ${commit.subject}`,
      file.path,
      "当前文件还没有可展示的 diff。",
    ];
  }

  const lines = [
    `${commit.shortSha} ${commit.subject}`,
    file.path,
    `AI 生成 ${fileAttribution.aiLines} | 人工编写 ${fileAttribution.humanLines} | 未识别 ${fileAttribution.unknownLines}`,
    `采集命中 ${file.observedEventCount} | AI 生成依据 ${file.evidenceSummary.aiHashMatchLines} | 人工快照 ${file.evidenceSummary.humanSnapshotLines} | 基于 AI 代码改写 ${file.evidenceSummary.humanRewriteLines}`,
    `手动标记 ${file.evidenceSummary.humanManualSnapshotLines} | 自动矫正 ${file.evidenceSummary.humanReconcileSnapshotLines}`,
    `新增 ${fileAttribution.aiLines + fileAttribution.humanLines + fileAttribution.unknownLines} | 删除 ${file.deletions}`,
    "归因依据 AI=实时快照哈希匹配 | 人工=手动标记/自动矫正/代码改写 | 未识别=证据不足",
  ];

  if (file.observedEventCount === 0) {
    lines.push("诊断提示：此文件未命中 Cursor 采集事件，若 Keep/Accept 未触发 Hook，会先归为未识别");
  }

  const sourceSummary = summarizeAttributedSources(fileAttribution);
  if (sourceSummary) {
    lines.push(sourceSummary);
  }

  lines.push("");

  const diffLines = fileAttribution.hunks.flatMap((hunk) => [
    hunk.header,
    ...hunk.lines.map((line) => formatAttributedLine(line)),
  ]);

  return [...lines, ...compactLines(diffLines, Math.max(4, detailLineBudget - lines.length))];
}

function buildDashboardLines(
  snapshot: AppSnapshot | null,
  lastDashboardUrl: string | null,
  tasks: TaskItem[],
  selectedTaskIndex: number,
  runningTaskId: string | null,
  runningTaskFrame: number,
): string[] {
  if (!snapshot) {
    return ["准备仪表盘中…"];
  }

  const lines = [
    lastDashboardUrl ? `访问地址 ${lastDashboardUrl}` : "地址读取中…",
    `提交总数 ${snapshot.branchData?.commitCount ?? 0} | AI 占比 ${formatPercent(snapshot.branchData?.aiLineCoveragePercent)} | 人工占比 ${formatPercent(snapshot.branchData?.humanLineCoveragePercent)}`,
    `原始采集 ${snapshot.rawTraceEvents ?? 0} | 数据标准化 ${snapshot.normalizedTraceEvents ?? 0} | 快照总数 ${snapshot.fileSnapshots ?? 0}`,
    "",
  ];

  return [
    ...lines,
    ...tasks.map((task, index) => `${index === selectedTaskIndex ? ">" : " "} ${displayTaskLabel(task, runningTaskId, runningTaskFrame)}`),
  ];
}

function buildTaskLines(
  snapshot: AppSnapshot | null,
  tasks: TaskItem[],
  selectedTaskIndex: number,
  title: string,
  runningTaskId: string | null,
  runningTaskFrame: number,
): string[] {
  if (!snapshot) {
    return ["准备中…"];
  }

  const lines = [
    `${title}`,
    `当前分支 ${snapshot.sourceBranch ?? "未知"} | 目标分支 ${snapshot.targetBranch ?? "未知"}`,
    `项目配置 ${snapshot.projectConfigExists ? "已就绪" : "未初始化"} | 状态目录 ${snapshot.storageRootExists ? "已就绪" : "未初始化"}`,
    `Cursor 集成 ${snapshot.cursorInstalled ? "已安装" : "未安装"} | 原始采集 ${snapshot.rawTraceEvents ?? 0} | 手动标记 ${snapshot.normalizedManualSnapshotEvents ?? 0} | 自动矫正 ${snapshot.normalizedReconcileSnapshotEvents ?? 0}`,
    "",
  ];

  if (snapshot.loadedConfig) {
    const { config, sources } = snapshot.loadedConfig;
    lines.push("当前生效配置 (Active Configuration):");

    const configRows = [
      { key: 'target_branch', val: config.targetBranch, src: sources.targetBranch, desc: '对比基准分支' },
      { key: 'ignore', val: `${config.ignore.length} 规则`, src: sources.ignore, desc: '忽略统计的文件模式' },
      { key: 'self_emails', val: `${config.selfEmails.length} 个`, src: sources.selfEmails, desc: '本人邮箱识别列表' },
      { key: 'cursor_hooks', val: config.cursorHooksEnabled ? '开启' : '关闭', src: sources.cursorHooksEnabled, desc: 'Cursor 实时采集' },
      { key: 'storage_root', val: config.storageRoot, src: sources.storageRoot, desc: '数据持久化路径' },
      { key: 'web_port', val: config.webPort, src: sources.webPort, desc: '仪表盘服务端口' },
      { key: 'ff_check', val: config.ffCheck ? '开启' : '关闭', src: sources.ffCheck, desc: '分支同步检查 (FF)' },
    ];

    for (const row of configRows) {
      const name = row.key.padEnd(14);
      const value = String(row.val).padEnd(12);
      const source = `[${row.src}]`.padEnd(10);
      lines.push(`  ${name} | ${value} | ${source} | ${row.desc}`);
    }
    lines.push("");
  }

  if (tasks.length === 0) {
    lines.push("当前没有需要执行的项目。");
    return lines;
  }

  return [
    ...lines,
    ...tasks.map((task, index) => `${index === selectedTaskIndex ? ">" : " "} ${displayTaskLabel(task, runningTaskId, runningTaskFrame)}`),
  ];
}

function buildHealthLines(
  snapshot: AppSnapshot | null,
  tasks: TaskItem[],
  selectedTaskIndex: number,
  runningTaskId: string | null,
  runningTaskFrame: number,
): string[] {
  if (!snapshot) {
    return ["准备健康状态中…"];
  }

  const lines = [
    `分支同步状态 ${formatFastForward(snapshot.canFastForward)}`,
    `领先提交 ${String(snapshot.ahead ?? "未知")} | 落后 ${String(snapshot.behind ?? "未知")} | 工作区修改 ${snapshot.dirtyCount ?? 0}`,
    `原始采集 ${snapshot.rawTraceEvents ?? 0} | 数据标准化 ${snapshot.normalizedTraceEvents ?? 0} | 人工快照 ${snapshot.normalizedHumanSnapshotEvents ?? 0}`,
    `手动标记 ${snapshot.normalizedManualSnapshotEvents ?? 0} | 自动矫正 ${snapshot.normalizedReconcileSnapshotEvents ?? 0} | 全量快照 ${snapshot.fileSnapshots ?? 0}`,
  ];

  if (snapshot.issues.length > 0) {
    lines.push("");
    for (const issue of snapshot.issues.slice(0, 4)) {
      lines.push(`- ${issue}`);
    }
  }

  if (tasks.length > 0) {
    lines.push("");
    for (const [index, task] of tasks.entries()) {
      lines.push(`${index === selectedTaskIndex ? ">" : " "} ${displayTaskLabel(task, runningTaskId, runningTaskFrame)}`);
    }
  }

  return lines;
}

function displayTaskLabel(task: TaskItem, runningTaskId: string | null, runningTaskFrame: number): string {
  if (task.id !== runningTaskId) {
    return task.label;
  }

  const prefix = `${spinnerFrame(runningTaskFrame)} `;

  if (task.id === "open-dashboard") {
    return `${prefix}打开中…`;
  }

  if (task.id === "refresh") {
    return `${prefix}刷新中…`;
  }

  return `${prefix}${task.label}（执行中…）`;
}

function spinnerFrame(frame: number): string {
  return TASK_SPINNER_FRAMES[frame % TASK_SPINNER_FRAMES.length] ?? TASK_SPINNER_FRAMES[0];
}

function buildSetupTasks(
  snapshot: AppSnapshot | null,
  cwd: string,
  setLastReport: React.Dispatch<React.SetStateAction<ReportState | null>>,
  refreshSnapshot: () => Promise<AppSnapshot | null>,
  setRunningTaskId: React.Dispatch<React.SetStateAction<string | null>>,
): TaskItem[] {
  const tasks: TaskItem[] = [];
  const needsInit = !snapshot?.projectConfigExists || !snapshot?.storageRootExists;
  const needsInstall = snapshot?.cursorInstalled === false;

  if (needsInit) {
    tasks.push({
      id: "init",
      label: "初始化当前仓库",
      run: async () => {
        await runCapturedTask("init", "初始化完成", () => runInit(cwd), setLastReport, refreshSnapshot, setRunningTaskId);
      },
    });
  }

  if (needsInstall) {
    tasks.push({
      id: "install",
      label: "安装 / 修复 Cursor 集成",
      run: async () => {
        await runCapturedTask("install", "安装完成", () => runCollectCursorInstall(cwd), setLastReport, refreshSnapshot, setRunningTaskId);
      },
    });
  }

  tasks.push({
    id: "refresh",
    label: "刷新当前状态",
    run: async () => {
      await runRefresh(refreshSnapshot, setLastReport, setRunningTaskId);
    },
  });

  return tasks;
}

function buildHealthTasks(
  snapshot: AppSnapshot | null,
  cwd: string,
  setLastReport: React.Dispatch<React.SetStateAction<ReportState | null>>,
  refreshSnapshot: () => Promise<AppSnapshot | null>,
  setRunningTaskId: React.Dispatch<React.SetStateAction<string | null>>,
): TaskItem[] {
  const tasks: TaskItem[] = [];

  if ((snapshot?.issues.length ?? 0) > 0) {
    tasks.push({
      id: "doctor",
      label: "运行健康检查",
      run: async () => {
        await runCapturedTask("doctor", "健康检查完成", () => runDoctor(cwd), setLastReport, refreshSnapshot, setRunningTaskId);
      },
    });
  }

  tasks.push({
    id: "refresh",
    label: "刷新当前状态",
    run: async () => {
      await runRefresh(refreshSnapshot, setLastReport, setRunningTaskId);
    },
  });

  return tasks;
}

function buildDashboardTasks(
  cwd: string,
  snapshot: AppSnapshot | null,
  setLastReport: React.Dispatch<React.SetStateAction<ReportState | null>>,
  setLastDashboardUrl: React.Dispatch<React.SetStateAction<string | null>>,
  setRunningTaskId: React.Dispatch<React.SetStateAction<string | null>>,
): TaskItem[] {
  return [
    {
      id: "open-dashboard",
      label: "打开浏览器仪表盘",
      run: async () => {
        await runDashboardLaunch(cwd, snapshot, setLastReport, setLastDashboardUrl, setRunningTaskId);
      },
    },
  ];
}

async function runDashboardLaunch(
  cwd: string,
  snapshot: AppSnapshot | null,
  setLastReport: React.Dispatch<React.SetStateAction<ReportState | null>>,
  setLastDashboardUrl: React.Dispatch<React.SetStateAction<string | null>>,
  setRunningTaskId: React.Dispatch<React.SetStateAction<string | null>>,
): Promise<void> {
  const dashboardUrl = `http://127.0.0.1:${snapshot?.webPort ?? 3487}`;
  const expectedRepoRoot = snapshot?.repoRoot ?? cwd;

  setRunningTaskId("open-dashboard");
  setLastReport({
    title: "正在启动仪表盘",
    tone: "neutral",
    lines: ["首次打开通常需要 1-2 秒，请稍等…", dashboardUrl],
  });

  try {
    launchDashboardDetached(cwd, { open: false });
    const ready = await waitForDashboardReady(dashboardUrl, expectedRepoRoot, 8000);
    setLastDashboardUrl(dashboardUrl);
    if (ready) {
      openUrl(dashboardUrl);
    }
    setLastReport({
      title: ready ? "仪表盘已启动" : "仪表盘正在后台启动",
      tone: ready ? "success" : "warn",
      lines: ready
        ? [dashboardUrl]
        : ["后台进程已发起，浏览器可能稍后打开。", dashboardUrl],
    });
  } catch (error) {
    setLastReport({
      title: "仪表盘启动失败",
      tone: "error",
      lines: normalizeLines(error instanceof Error ? error.message : String(error), 2),
    });
  } finally {
    setRunningTaskId(null);
  }
}

async function waitForDashboardReady(baseUrl: string, expectedRepoRoot: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const normalizedExpectedRepoRoot = normalizeRepoRoot(expectedRepoRoot);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/snapshot`, { redirect: "manual" });
      if (response.ok) {
        const snapshot = await response.json() as { repoRoot?: string };
        if (normalizeRepoRoot(snapshot.repoRoot) === normalizedExpectedRepoRoot) {
          return true;
        }
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(200);
  }

  return false;
}

function normalizeRepoRoot(repoRoot: string | undefined): string | null {
  if (!repoRoot) {
    return null;
  }

  return resolvePath(repoRoot);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runCapturedTask(
  id: string,
  title: string,
  runner: () => Promise<number>,
  setLastReport: React.Dispatch<React.SetStateAction<ReportState | null>>,
  refreshSnapshot: () => Promise<AppSnapshot | null>,
  setRunningTaskId: React.Dispatch<React.SetStateAction<string | null>>,
): Promise<void> {
  setRunningTaskId(id);

  try {
    const result = await captureCommandOutput(runner);
    const nextSnapshot = await refreshSnapshot();
    setLastReport({
      title,
      tone: result.exitCode === 0 ? "success" : "warn",
      lines: normalizeLines(
        result.output.length > 0
          ? result.output
          : result.exitCode === 0
            ? "执行完成。"
            : `执行结束，退出码 ${result.exitCode}。`,
        nextSnapshot?.tone === "fail" ? 3 : 2,
      ),
    });
  } catch (error) {
    setLastReport({
      title,
      tone: "error",
      lines: normalizeLines(error instanceof Error ? error.stack ?? error.message : String(error), 2),
    });
  } finally {
    setRunningTaskId(null);
  }
}

async function runRefresh(
  refreshSnapshot: () => Promise<AppSnapshot | null>,
  setLastReport: React.Dispatch<React.SetStateAction<ReportState | null>>,
  setRunningTaskId: React.Dispatch<React.SetStateAction<string | null>>,
): Promise<void> {
  setRunningTaskId("refresh");
  try {
    const nextSnapshot = await refreshSnapshot();
    setLastReport({
      title: "已刷新",
      tone: snapshotToReportTone(nextSnapshot),
      lines: [],
    });
  } finally {
    setRunningTaskId(null);
  }
}

function cycleSurface(
  direction: -1 | 1,
  current: NavSurface,
  setRoute: React.Dispatch<React.SetStateAction<AppRoute>>,
): void {
  const index = NAV_ORDER.indexOf(current);
  const nextIndex = (index + direction + NAV_ORDER.length) % NAV_ORDER.length;
  const nextSurface = NAV_ORDER[nextIndex] ?? "stats";
  setRoute(navSurfaceToRoute(nextSurface));
}

function routeToSurface(route: AppRoute): NavSurface {
  if (route.kind === "stats") {
    return "stats";
  }

  if (route.kind === "commits" || route.kind === "commit-detail" || route.kind === "file-detail") {
    return "commits";
  }

  if (route.kind === "dashboard") {
    return "dashboard";
  }

  if (route.kind === "setup") {
    return "setup";
  }

  return "health";
}

function navSurfaceToRoute(surface: NavSurface): AppRoute {
  if (surface === "stats") {
    return { kind: "stats" };
  }

  if (surface === "commits") {
    return { kind: "commits" };
  }

  if (surface === "dashboard") {
    return { kind: "dashboard" };
  }

  if (surface === "setup") {
    return { kind: "setup" };
  }

  return { kind: "health" };
}

function getSurfaceTitle(route: AppRoute): string {
  if (route.kind === "stats") {
    return "统计";
  }

  if (route.kind === "commits") {
    return "提交列表";
  }

  if (route.kind === "commit-detail") {
    return "提交详情";
  }

  if (route.kind === "file-detail") {
    return "文件详情";
  }

  if (route.kind === "dashboard") {
    return "仪表盘";
  }

  if (route.kind === "setup") {
    return "设置";
  }

  return "健康";
}

function formatCommitRow(commit: CommitDataSummary): string {
  return `${commit.shortSha} | AI ${formatPercent(commit.aiLineCoveragePercent)} | H ${formatPercent(commit.humanLineCoveragePercent)} | ${commit.subject}`;
}

function formatCommitFileLine(file: CommitCoverageFile): string {
  const modelLabel = file.models.length > 0 ? ` ${file.models[0]}` : "";
  return `${file.path} | AI ${file.aiLines} | H ${file.humanLines} | U ${file.unknownLines}${modelLabel}`;
}

type FileDetailEntry =
  | { kind: "hunk"; header: string }
  | {
    kind: "row";
    left?: CommitFileAttribution["hunks"][number]["lines"][number];
    right?: CommitFileAttribution["hunks"][number]["lines"][number];
  };

function formatAttributedLine(line: CommitFileAttribution["hunks"][number]["lines"][number]): string {
  const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
  const tag = line.attribution === "ai"
    ? "AI"
    : line.attribution === "human"
      ? "Human"
      : line.attribution === "unknown"
        ? "Unknown"
        : line.attribution === "remove"
          ? line.sourceAttribution === "ai"
            ? "删·AI源"
            : line.sourceAttribution === "human"
              ? "删·H源"
              : "删"
          : "";
  const label = tag ? `[${tag}] ` : "";
  return `${prefix} ${label}${line.text}`;
}

function buildFileDetailHeaderLines(
  commit: CommitDataSummary,
  file: CommitCoverageFile,
  fileAttribution: CommitFileAttribution,
  showContextLines: boolean,
): string[] {
  const lines = [
    `${commit.shortSha} ${commit.subject}`,
    file.path,
    `AI ${fileAttribution.aiLines} | Human ${fileAttribution.humanLines} | Unknown ${fileAttribution.unknownLines}`,
    `Cursor事件 ${file.observedEventCount} | AI哈希 ${file.evidenceSummary.aiHashMatchLines} | Human快照 ${file.evidenceSummary.humanSnapshotLines} | 改写AI ${file.evidenceSummary.humanRewriteLines}`,
    `人工快照 ${file.evidenceSummary.humanManualSnapshotLines} | Reconcile ${file.evidenceSummary.humanReconcileSnapshotLines}`,
    `新增 ${file.additions} | 删除 ${file.deletions}`,
    `视图 ${showContextLines ? "完整（含上下文）" : "精简（仅改动行）"} | 按 c 切换`,
    "策略 AI=快照哈希命中 | Human=人工快照/Reconcile/改写 | Unknown=证据不足",
  ];

  if (file.observedEventCount === 0) {
    lines.push("诊断 当前文件没有命中 Cursor raw 事件，若 Keep/Accept 未触发 hook，会先归为 Unknown");
  }

  const sourceSummary = summarizeAttributedSources(fileAttribution);
  if (sourceSummary) {
    lines.push(sourceSummary);
  }

  return lines;
}

function buildFileDetailEntries(fileAttribution: CommitFileAttribution, showContextLines: boolean): FileDetailEntry[] {
  return buildSplitDiffRows(fileAttribution.hunks, {
    includeContext: showContextLines,
  }).map((row) => {
    if (row.kind === "hunk") {
      return row;
    }

    return {
      kind: "row" as const,
      left: row.left?.source,
      right: row.right?.source,
    };
  });
}

function applyDetailWindow(
  entries: FileDetailEntry[],
  lineBudget: number,
  scrollOffset: number,
): {
  visibleEntries: FileDetailEntry[];
  hasOverflowAbove: boolean;
  hasOverflowBelow: boolean;
  remainingAbove: number;
  remainingBelow: number;
} {
  if (entries.length === 0) {
    return {
      visibleEntries: [],
      hasOverflowAbove: false,
      hasOverflowBelow: false,
      remainingAbove: 0,
      remainingBelow: 0,
    };
  }

  const start = clamp(scrollOffset, 0, Math.max(0, entries.length - 1));
  const hasOverflowAbove = start > 0;
  let visibleCount = Math.max(1, lineBudget - (hasOverflowAbove ? 1 : 0));
  let visibleEntries = entries.slice(start, start + visibleCount);
  let remainingBelow = Math.max(0, entries.length - (start + visibleEntries.length));

  if (remainingBelow > 0 && visibleEntries.length > 1) {
    visibleCount = Math.max(1, visibleCount - 1);
    visibleEntries = entries.slice(start, start + visibleCount);
    remainingBelow = Math.max(0, entries.length - (start + visibleEntries.length));
  }

  return {
    visibleEntries,
    hasOverflowAbove,
    hasOverflowBelow: remainingBelow > 0,
    remainingAbove: start,
    remainingBelow,
  };
}

function getFileDetailScrollMax(
  snapshot: AppSnapshot | null,
  commit: CommitDataSummary | null,
  file: CommitCoverageFile | null,
  fileAttribution: CommitFileAttribution | null,
  detailLineBudget: number,
  showContextLines: boolean,
): number {
  if (!snapshot?.available || !commit || !file || !fileAttribution) {
    return 0;
  }

  const fixedLines = buildFileDetailHeaderLines(commit, file, fileAttribution, showContextLines).length;
  const viewportSize = Math.max(1, detailLineBudget - fixedLines - 1);
  const totalEntries = buildFileDetailEntries(fileAttribution, showContextLines).length;

  return Math.max(0, totalEntries - viewportSize);
}

function linePrefixSymbol(line: CommitFileAttribution["hunks"][number]["lines"][number]): string {
  return line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
}

function linePrefixColor(
  line: CommitFileAttribution["hunks"][number]["lines"][number],
): "green" | "red" | "gray" {
  if (line.kind === "add") {
    return "green";
  }

  if (line.kind === "remove") {
    return "red";
  }

  return "gray";
}

function SplitDiffCell({
  line,
  side,
  filePath,
}: {
  line: CommitFileAttribution["hunks"][number]["lines"][number] | undefined;
  side: "old" | "new";
  filePath: string;
}) {
  const rowBackground = line ? rowBackgroundColor(line, side) : undefined;

  if (!line) {
    return (
      <Text wrap="truncate-end">
        <Text color="gray" backgroundColor={rowBackground}>  </Text>
        <Text color="gray" backgroundColor={rowBackground}>     </Text>
      </Text>
    );
  }

  const marker = linePrefixSymbol(line);
  const lineNumber = side === "old"
    ? (line.oldLineNumber === null ? "----" : String(line.oldLineNumber).padStart(4, " "))
    : (line.newLineNumber === null ? "----" : String(line.newLineNumber).padStart(4, " "));

  return (
    <Text wrap="truncate-end">
      <Text color={linePrefixColor(line)} backgroundColor={rowBackground}>{marker} </Text>
      <Text color={rowBackground ? "black" : "gray"} backgroundColor={rowBackground}>{lineNumber} </Text>
      <AttributionBadge line={line} />
      <Text> </Text>
      <InlineSegmentsText line={line} filePath={filePath} />
    </Text>
  );
}

function rowBackgroundColor(
  line: CommitFileAttribution["hunks"][number]["lines"][number],
  side: "old" | "new",
): InkColor | undefined {
  if (side === "old" && line.kind === "remove") {
    return "red";
  }

  return undefined;
}

function inlineSegmentColor(
  attribution: CommitFileAttribution["hunks"][number]["lines"][number]["inlineSegments"][number]["attribution"],
): InkColor {
  if (attribution === "ai") {
    return "cyanBright";
  }

  if (attribution === "human") {
    return "blueBright";
  }

  if (attribution === "unknown") {
    return "yellowBright";
  }

  return "gray";
}

function inlineSegmentBackground(
  attribution: CommitFileAttribution["hunks"][number]["lines"][number]["inlineSegments"][number]["attribution"],
): InkColor | undefined {
  return attribution === "source" ? "gray" : undefined;
}

function summarizeAttributedSources(fileAttribution: CommitFileAttribution): string | null {
  const models = new Set<string>();
  const sessionIds = new Set<string>();

  for (const hunk of fileAttribution.hunks) {
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

  if (models.size === 0 && sessionIds.size === 0) {
    return null;
  }

  return `模型 ${[...models].join(", ") || "无"} | 会话 ${sessionIds.size}`;
}

function getCommitTimeline(snapshot: AppSnapshot | null): CommitDataSummary[] {
  return snapshot?.branchData ? [...snapshot.branchData.commits].reverse() : [];
}

function getPreferredFileIndex(files: CommitCoverageFile[]): number {
  const aiLineIndex = files.findIndex((file) => file.aiLines > 0);
  if (aiLineIndex >= 0) {
    return aiLineIndex;
  }

  const humanLineIndex = files.findIndex((file) => file.humanLines > 0);
  if (humanLineIndex >= 0) {
    return humanLineIndex;
  }

  const aiIndex = files.findIndex((file) => file.observedByCursor);
  return aiIndex >= 0 ? aiIndex : 0;
}

function buildShortcutLine(route: AppRoute, taskCount: number, showContextLines: boolean): string {
  const parts = ["←/→ 页面", "Enter 确认", "Esc 返回", "r 刷新", "q 退出"];

  if (route.kind === "file-detail") {
    parts.splice(1, 0, "↑/↓ 滚动", "[/] 切文件", `c 上下文(${showContextLines ? "完整" : "精简"})`);
    return parts.join("  ");
  }

  if (route.kind === "commit-detail") {
    parts.splice(1, 0, "↑/↓ 选文件");
    return parts.join("  ");
  }

  parts.splice(1, 0, "↑/↓ 选择");

  if ((route.kind === "setup" || route.kind === "health" || route.kind === "dashboard") && taskCount > 1) {
    parts.push("1-5 直达");
  }

  return parts.join("  ");
}

function buildSelectedFileAttribution(
  route: AppRoute,
  snapshot: AppSnapshot | null,
  selectedCommitIndex: number,
  selectedFileIndex: number,
): CommitFileAttribution | null {
  if (route.kind !== "file-detail") {
    return null;
  }

  if (!snapshot?.available || !snapshot.branchData || !snapshot.repoRoot || !snapshot.storageRoot) {
    return null;
  }

  const timeline = getCommitTimeline(snapshot);
  const commit = timeline[selectedCommitIndex] ?? null;
  const file = commit?.files[selectedFileIndex] ?? null;

  if (!commit || !file) {
    return null;
  }

  const previousAuthoredAt = timeline[selectedCommitIndex + 1]?.authoredAt
    ?? snapshot.branchData.baseCommittedAt
    ?? null;

  return buildCommitFileAttribution({
    repoRoot: snapshot.repoRoot,
    statePaths: {
      storageRoot: snapshot.storageRoot,
      rawDir: `${snapshot.storageRoot}/raw`,
      cacheDir: `${snapshot.storageRoot}/cache`,
      snapshotsDir: `${snapshot.storageRoot}/cache/snapshots`,
      indexFile: `${snapshot.storageRoot}/index.sqlite`,
    },
    currentBranch: snapshot.sourceBranch ?? "HEAD",
    commit,
    previousAuthoredAt,
    file,
  });
}

function normalizeLines(text: string, maxLines: number): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length <= maxLines) {
    return lines;
  }

  return [...lines.slice(0, maxLines), `... 其余 ${lines.length - maxLines} 行已折叠`];
}

function compactLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  return [...lines.slice(0, maxLines - 1), `... 其余 ${lines.length - maxLines + 1} 行`];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function windowAround<T>(items: T[], selectedIndex: number, windowSize: number): T[] {
  if (items.length <= windowSize) {
    return items;
  }

  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, selectedIndex - half);
  let end = Math.min(items.length, start + windowSize);

  if (end - start < windowSize) {
    start = Math.max(0, end - windowSize);
  }

  return items.slice(start, end);
}

function snapshotToReportTone(snapshot: AppSnapshot | null): ReportTone {
  if (!snapshot) {
    return "neutral";
  }

  if (snapshot.tone === "fail") {
    return "error";
  }

  if (snapshot.tone === "warn") {
    return "warn";
  }

  return "success";
}

function summaryLineColor(
  tone: SnapshotTone,
  line: string,
): InkColor {
  if (line.startsWith("> ")) {
    return "cyan";
  }

  if (line.startsWith("@@")) {
    return "blue";
  }

  if (line.startsWith("+ ")) {
    return "green";
  }

  if (line.startsWith("- ")) {
    return "gray";
  }

  if (tone === "fail") {
    return "red";
  }

  if (tone === "warn") {
    return "yellow";
  }

  return "white";
}

function toneToColor(tone: SnapshotTone): "green" | "yellow" | "red" {
  if (tone === "ok") {
    return "green";
  }

  if (tone === "warn") {
    return "yellow";
  }

  return "red";
}

function toneToLabel(tone: SnapshotTone): string {
  if (tone === "ok") {
    return "已就绪";
  }

  if (tone === "warn") {
    return "需处理";
  }

  return "有阻塞";
}

function sectionTitleColor(
  color: "green" | "yellow" | "red" | "blue" | "cyan" | "gray",
): "white" | "greenBright" | "yellowBright" | "redBright" | "blueBright" | "cyanBright" {
  if (color === "green") {
    return "greenBright";
  }

  if (color === "yellow") {
    return "yellowBright";
  }

  if (color === "red") {
    return "redBright";
  }

  if (color === "blue") {
    return "blueBright";
  }

  if (color === "cyan") {
    return "cyanBright";
  }

  return "white";
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return `${value.toFixed(1)}%`;
}

function formatFastForward(value: boolean | null | undefined): string {
  if (value === true) {
    return "可用";
  }

  if (value === false) {
    return "不满足";
  }

  return "未知";
}
