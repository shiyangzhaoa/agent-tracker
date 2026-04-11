import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";

import { runCollectCursorInstall } from "../commands/collect-cursor-install";
import { runDoctor } from "../commands/doctor";
import { runInit } from "../commands/init";
import { captureCommandOutput } from "../lib/capture";
import type { CommitCoverageFile, CommitDataSummary } from "../lib/branch-data";
import { getAppSnapshot, type AppSnapshot, type SnapshotTone } from "../lib/snapshot";

type NavSurface = "stats" | "commits" | "setup" | "health";
type AppRoute =
  | { kind: "stats" }
  | { kind: "commits" }
  | { kind: "commit-detail"; sha: string }
  | { kind: "setup" }
  | { kind: "health" };
type ReportTone = "neutral" | "success" | "warn" | "error";

interface ReportState {
  title: string;
  tone: ReportTone;
  lines: string[];
}

interface SetupState {
  needsInit: boolean;
  needsInstall: boolean;
  needsAttention: boolean;
}

interface NavItem {
  label: string;
  value: NavSurface;
}

interface ActionItem {
  id: string;
  label: string;
  run: (() => Promise<void>) | null;
  disabled?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: "统计", value: "stats" },
  { label: "提交", value: "commits" },
  { label: "设置", value: "setup" },
  { label: "健康", value: "health" },
];

const SURFACE_LABELS: Record<NavSurface, string> = {
  stats: "统计",
  commits: "提交",
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
  const [route, setRoute] = useState<AppRoute>({ kind: "stats" });
  const [selectedCommitIndex, setSelectedCommitIndex] = useState(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(true);
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<ReportState | null>(null);

  const surface = routeToSurface(route);

  const refreshSnapshot = async () => {
    setLoadingSnapshot(true);

    try {
      const nextSnapshot = await getAppSnapshot(cwd);
      setSnapshot(nextSnapshot);
      return nextSnapshot;
    } finally {
      setLoadingSnapshot(false);
    }
  };

  useEffect(() => {
    void refreshSnapshot();
  }, [cwd]);

  const commitTimeline = getCommitTimeline(snapshot);
  const selectedCommit = commitTimeline[selectedCommitIndex] ?? null;
  const setupState = getSetupState(snapshot);

  useEffect(() => {
    if (selectedCommitIndex >= commitTimeline.length) {
      setSelectedCommitIndex(0);
    }
  }, [commitTimeline.length, selectedCommitIndex]);

  useEffect(() => {
    if (route.kind === "commit-detail") {
      const nextIndex = commitTimeline.findIndex((commit) => commit.sha === route.sha);
      if (nextIndex >= 0 && nextIndex !== selectedCommitIndex) {
        setSelectedCommitIndex(nextIndex);
      }

      if (commitTimeline.length === 0) {
        setRoute({ kind: "commits" });
      }
    }
  }, [commitTimeline, route, selectedCommitIndex]);

  const runCapturedAction = async (
    id: string,
    title: string,
    runner: () => Promise<number>,
  ) => {
    setRunningActionId(id);

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
          4,
        ),
      });

      if (id === "refresh") {
        setLastReport({
          title: "已刷新",
          tone: snapshotToReportTone(nextSnapshot),
          lines: [],
        });
      }
    } catch (error) {
      setLastReport({
        title,
        tone: "error",
        lines: normalizeLines(error instanceof Error ? error.stack ?? error.message : String(error), 4),
      });
    } finally {
      setRunningActionId(null);
    }
  };

  const actions = useMemo<ActionItem[]>(() => {
    const items: ActionItem[] = [];

    if (route.kind === "stats") {
      if ((snapshot?.branchData?.commitCount ?? 0) > 0) {
        items.push({
          id: "open-commits",
          label: "打开提交",
          run: async () => {
            setRoute({ kind: "commits" });
          },
        });
      }

      items.push({
        id: "refresh",
        label: "刷新",
        run: async () => {
          await runCapturedAction("refresh", "已刷新", async () => 0);
        },
      });

      return items;
    }

    if (route.kind === "commits") {
      if (selectedCommit) {
        items.push({
          id: "commit-detail",
          label: "详情",
          run: async () => {
            setRoute({ kind: "commit-detail", sha: selectedCommit.sha });
          },
        });
      }

      if (commitTimeline.length > 0) {
        items.push(
          {
            id: "prev-commit",
            label: "上一条",
            run: async () => {
              setSelectedCommitIndex((current) => Math.min(current + 1, Math.max(0, commitTimeline.length - 1)));
            },
          },
          {
            id: "next-commit",
            label: "下一条",
            run: async () => {
              setSelectedCommitIndex((current) => Math.max(current - 1, 0));
            },
          },
        );
      }

      items.push({
        id: "refresh",
        label: "刷新",
        run: async () => {
          await runCapturedAction("refresh", "已刷新", async () => 0);
        },
      });

      return items;
    }

    if (route.kind === "commit-detail") {
      items.push({
        id: "commit-list",
        label: "列表",
        run: async () => {
          setRoute({ kind: "commits" });
        },
      });

      if (commitTimeline.length > 0) {
        items.push(
          {
            id: "prev-commit",
            label: "上一条",
            run: async () => {
              const nextIndex = Math.min(selectedCommitIndex + 1, Math.max(0, commitTimeline.length - 1));
              const nextCommit = commitTimeline[nextIndex];
              if (nextCommit) {
                setSelectedCommitIndex(nextIndex);
                setRoute({ kind: "commit-detail", sha: nextCommit.sha });
              }
            },
          },
          {
            id: "next-commit",
            label: "下一条",
            run: async () => {
              const nextIndex = Math.max(selectedCommitIndex - 1, 0);
              const nextCommit = commitTimeline[nextIndex];
              if (nextCommit) {
                setSelectedCommitIndex(nextIndex);
                setRoute({ kind: "commit-detail", sha: nextCommit.sha });
              }
            },
          },
        );
      }

      items.push({
        id: "refresh",
        label: "刷新",
        run: async () => {
          await runCapturedAction("refresh", "已刷新", async () => 0);
        },
      });

      return items;
    }

    if (route.kind === "setup") {
      if (setupState.needsInit) {
        items.push({
          id: "init",
          label: "初始化",
          run: async () => {
            await runCapturedAction("init", "初始化仓库", () => runInit(cwd));
          },
        });
      } else if (setupState.needsInstall) {
        items.push({
          id: "install",
          label: "安装集成",
          run: async () => {
            await runCapturedAction("install", "安装 Cursor 集成", () => runCollectCursorInstall(cwd));
          },
        });
      }

      items.push({
        id: "refresh",
        label: "刷新",
        run: async () => {
          await runCapturedAction("refresh", "已刷新", async () => 0);
        },
      });

      return items;
    }

    if ((snapshot?.issues.length ?? 0) > 0) {
      items.push({
        id: "doctor",
        label: "检查",
        run: async () => {
          await runCapturedAction("doctor", "健康检查", () => runDoctor(cwd));
        },
      });
    }

    items.push({
      id: "refresh",
      label: "刷新",
      run: async () => {
        await runCapturedAction("refresh", "已刷新", async () => 0);
      },
    });

    return items;
  }, [commitTimeline, cwd, route, selectedCommit, selectedCommitIndex, setupState.needsInit, setupState.needsInstall, snapshot?.branchData?.commitCount, snapshot?.issues.length]);

  useEffect(() => {
    if (selectedActionIndex >= actions.length) {
      setSelectedActionIndex(0);
    }
  }, [actions.length, selectedActionIndex]);

  useEffect(() => {
    const firstEnabledIndex = actions.findIndex((action) => !action.disabled && action.run);
    if (firstEnabledIndex >= 0 && (actions[selectedActionIndex]?.disabled || !actions[selectedActionIndex]?.run)) {
      setSelectedActionIndex(firstEnabledIndex);
    }
  }, [actions, selectedActionIndex]);

  const selectedAction = actions[selectedActionIndex] ?? null;
  const navSurface = routeToSurface(route);
  const contentLines = compactLines(
    buildContentLines(route, snapshot, selectedCommitIndex, lastReport),
    12,
  );

  useInput((input, key) => {
    if (runningActionId) {
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
      }
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }

    if (key.leftArrow) {
      setSelectedActionIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setSelectedActionIndex((current) => Math.min(actions.length - 1, current + 1));
      return;
    }

    if (input === "r") {
      void runCapturedAction("refresh", "已刷新", async () => 0);
      return;
    }

    if ((key.return || input === "a") && selectedAction?.run && !selectedAction.disabled) {
      void selectedAction.run();
      return;
    }

    if ((route.kind === "commits" || route.kind === "commit-detail") && input === "[") {
      const nextIndex = Math.min(selectedCommitIndex + 1, Math.max(0, commitTimeline.length - 1));
      setSelectedCommitIndex(nextIndex);
      if (route.kind === "commit-detail") {
        const nextCommit = commitTimeline[nextIndex];
        if (nextCommit) {
          setRoute({ kind: "commit-detail", sha: nextCommit.sha });
        }
      }
      return;
    }

    if ((route.kind === "commits" || route.kind === "commit-detail") && input === "]") {
      const nextIndex = Math.max(selectedCommitIndex - 1, 0);
      setSelectedCommitIndex(nextIndex);
      if (route.kind === "commit-detail") {
        const nextCommit = commitTimeline[nextIndex];
        if (nextCommit) {
          setRoute({ kind: "commit-detail", sha: nextCommit.sha });
        }
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header
        loadingSnapshot={loadingSnapshot}
        snapshot={snapshot}
        surface={navSurface}
        selectedCommit={selectedCommit}
        runningActionId={runningActionId}
      />

      <Box marginTop={1} flexDirection="row">
        <Box width={14} marginRight={1} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
          <Text color="cyanBright">页面</Text>
          <SelectInput
            key={navSurface}
            items={NAV_ITEMS}
            initialIndex={NAV_ITEMS.findIndex((item) => item.value === navSurface)}
            isFocused={!runningActionId}
            onHighlight={(item) => {
              setRoute(navSurfaceToRoute(item.value));
              setSelectedActionIndex(0);
            }}
            onSelect={(item) => {
              setRoute(navSurfaceToRoute(item.value));
              setSelectedActionIndex(0);
            }}
          />
        </Box>

        <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} paddingY={0}>
          <Text color="blueBright">{getSurfaceTitle(route)}</Text>
          <SummaryLines lines={contentLines} tone={snapshot?.tone ?? "warn"} />
        </Box>
      </Box>

      <ActionBar
        actions={actions}
        runningActionId={runningActionId}
        selectedActionIndex={selectedActionIndex}
        shortcuts={buildShortcutLine(route, commitTimeline.length)}
      />
    </Box>
  );
}

function Header({
  loadingSnapshot,
  snapshot,
  surface,
  selectedCommit,
  runningActionId,
}: {
  loadingSnapshot: boolean;
  snapshot: AppSnapshot | null;
  surface: NavSurface;
  selectedCommit: CommitDataSummary | null;
  runningActionId: string | null;
}) {
  const tone = snapshot?.tone ?? "warn";
  const toneColor = toneToColor(tone);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={toneColor} paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyanBright">agent-tracker</Text>
        <Text>  </Text>
        <Badge color={toneColor} label={toneToLabel(tone)} />
        <Text>  </Text>
        <Badge color="blue" label={SURFACE_LABELS[surface]} />
        {runningActionId ? (
          <>
            <Text>  </Text>
            <Badge color="yellow" label={`执行中 ${runningActionId}`} />
          </>
        ) : null}
      </Box>
      <Text>{loadingSnapshot ? "正在更新…" : buildHeaderSummary(snapshot, surface, selectedCommit)}</Text>
    </Box>
  );
}

function ActionBar({
  actions,
  runningActionId,
  selectedActionIndex,
  shortcuts,
}: {
  actions: ActionItem[];
  runningActionId: string | null;
  selectedActionIndex: number;
  shortcuts: string;
}) {
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} paddingY={0}>
      <Box>
        <Text color="white">操作</Text>
        <Text>  </Text>
        {actions.length > 0 ? (
          actions.map((action, index) => (
            <ActionChip
              key={action.id}
              label={action.label}
              active={index === selectedActionIndex}
              disabled={Boolean(action.disabled || runningActionId)}
            />
          ))
        ) : (
          <Text color="gray">当前无动作</Text>
        )}
      </Box>
      <Text color="gray">{shortcuts}</Text>
    </Box>
  );
}

function ActionChip({
  label,
  active,
  disabled,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
}) {
  if (disabled) {
    return (
      <Text color="gray">
        {" ["}{label}{"] "}
      </Text>
    );
  }

  if (active) {
    return (
      <Text color="black" backgroundColor="green">
        {" "}{label}{" "}
      </Text>
    );
  }

  return <Text color="white"> [{label}] </Text>;
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
          {line}
        </Text>
      ))}
    </Box>
  );
}

function routeToSurface(route: AppRoute): NavSurface {
  if (route.kind === "stats") {
    return "stats";
  }

  if (route.kind === "commits" || route.kind === "commit-detail") {
    return "commits";
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

  if (route.kind === "setup") {
    return "设置";
  }

  return "健康";
}

function buildHeaderSummary(
  snapshot: AppSnapshot | null,
  surface: NavSurface,
  selectedCommit: CommitDataSummary | null,
): string {
  if (!snapshot?.available) {
    return snapshot?.summary ?? "当前还没有可展示的数据。";
  }

  const parts = [
    `${snapshot.targetBranch ?? "未知"} -> ${snapshot.sourceBranch ?? "未知"}`,
    `${snapshot.branchData?.commitCount ?? 0} commits`,
  ];

  if (surface === "stats") {
    parts.push(`覆盖 ${formatPercent(snapshot.branchData?.observedFileCoveragePercent)}`);
  }

  if (surface === "commits" && selectedCommit) {
    parts.push(selectedCommit.shortSha);
  }

  return parts.join(" | ");
}

function buildContentLines(
  route: AppRoute,
  snapshot: AppSnapshot | null,
  selectedCommitIndex: number,
  lastReport: ReportState | null,
): string[] {
  const lines = route.kind === "stats"
    ? buildStatsLines(snapshot)
    : route.kind === "commits"
      ? buildCommitListLines(snapshot, selectedCommitIndex)
      : route.kind === "commit-detail"
        ? buildCommitDetailLines(snapshot, selectedCommitIndex)
        : route.kind === "setup"
          ? buildSetupLines(snapshot)
          : buildHealthLines(snapshot);

  if (!lastReport) {
    return lines;
  }

  const reportLines = [lastReport.title, ...lastReport.lines].slice(0, 3);
  if (reportLines.length === 0) {
    return lines;
  }

  return [...lines, "", ...reportLines];
}

function buildStatsLines(snapshot: AppSnapshot | null): string[] {
  if (!snapshot) {
    return ["准备统计中…"];
  }

  if (!snapshot.available) {
    return [snapshot.summary, ...snapshot.issues];
  }

  const branchData = snapshot.branchData;
  const lines = [
    `范围 ${snapshot.targetBranch ?? "未知"} -> ${snapshot.sourceBranch ?? "未知"}`,
    `提交 ${branchData?.commitCount ?? 0} | 自己 ${branchData?.selfCommitCount ?? 0} | 他人 ${branchData?.teammateCommitCount ?? 0}`,
    `文件覆盖 ${formatPercent(branchData?.observedFileCoveragePercent)} | 新增行覆盖 ${formatPercent(branchData?.observedAdditionCoveragePercent)}`,
  ];

  for (const commit of branchData?.recentCommits.slice(0, 3) ?? []) {
    lines.push(`- ${commit.shortSha} ${commit.subject}`);
  }

  if ((branchData?.commitCount ?? 0) === 0) {
    lines.push("当前范围内还没有新增 commit。");
  }

  return lines;
}

function buildCommitListLines(snapshot: AppSnapshot | null, selectedCommitIndex: number): string[] {
  if (!snapshot?.available || !snapshot.branchData) {
    return ["当前还没有可展示的提交。"];
  }

  const timeline = getCommitTimeline(snapshot);
  if (timeline.length === 0) {
    return ["当前范围内还没有新增 commit。"];
  }

  const lines = [`共 ${timeline.length} 条提交`];

  for (const [index, commit] of timeline.entries()) {
    const marker = index === selectedCommitIndex ? ">" : " ";
    lines.push(
      `${marker} ${commit.shortSha}  ${formatPercent(commit.observedFileCoveragePercent)}  ${commit.subject}`,
    );
  }

  return lines;
}

function buildCommitDetailLines(snapshot: AppSnapshot | null, selectedCommitIndex: number): string[] {
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
    `文件 ${commit.filesChanged} | 新增 ${commit.additions} | 删除 ${commit.deletions}`,
    `文件覆盖 ${formatPercent(commit.observedFileCoveragePercent)} | 新增行覆盖 ${formatPercent(commit.observedAdditionCoveragePercent)}`,
  ];

  for (const file of commit.files.slice(0, 5)) {
    lines.push(formatCommitFileLine(file));
  }

  return lines;
}

function formatCommitFileLine(file: CommitCoverageFile): string {
  const source = file.observedByCursor
    ? `AI${file.models.length > 0 ? `:${file.models[0]}` : ""}`
    : "未知";
  return `- ${file.path}  +${file.additions} -${file.deletions}  ${source}`;
}

function buildSetupLines(snapshot: AppSnapshot | null): string[] {
  if (!snapshot) {
    return ["准备设置中…"];
  }

  if (!snapshot.available) {
    return [snapshot.summary, ...snapshot.issues];
  }

  return [
    `当前分支 ${snapshot.sourceBranch ?? "未知"}`,
    `目标分支 ${snapshot.targetBranch ?? "未知"}`,
    `配置 ${snapshot.projectConfigExists ? "已存在" : "缺失"} | 状态目录 ${snapshot.storageRootExists ? "已存在" : "缺失"}`,
    `Cursor ${snapshot.cursorInstalled ? "已安装" : "未安装"} | Raw ${snapshot.rawTraceEvents ?? 0}`,
    `Normalized ${snapshot.normalizedTraceEvents ?? 0} | Snapshots ${snapshot.fileSnapshots ?? 0}`,
  ];
}

function buildHealthLines(snapshot: AppSnapshot | null): string[] {
  if (!snapshot) {
    return ["准备健康状态中…"];
  }

  if (!snapshot.available) {
    return [snapshot.summary, ...snapshot.issues];
  }

  const lines = [
    `Fast-forward ${formatFastForward(snapshot.canFastForward)}`,
    `领先 ${String(snapshot.ahead ?? "未知")} | 落后 ${String(snapshot.behind ?? "未知")}`,
    `工作区 ${snapshot.dirtyCount ?? 0} | Raw ${snapshot.rawTraceEvents ?? 0} | Normalized ${snapshot.normalizedTraceEvents ?? 0}`,
  ];

  for (const issue of snapshot.issues.slice(0, 3)) {
    lines.push(`- ${issue}`);
  }

  return lines;
}

function getCommitTimeline(snapshot: AppSnapshot | null): CommitDataSummary[] {
  return snapshot?.branchData ? [...snapshot.branchData.commits].reverse() : [];
}

function getSetupState(snapshot: AppSnapshot | null): SetupState {
  if (!snapshot?.available) {
    return {
      needsInit: false,
      needsInstall: false,
      needsAttention: true,
    };
  }

  const needsInit = !snapshot.projectConfigExists || !snapshot.storageRootExists;
  const needsInstall = snapshot.cursorInstalled === false;

  return {
    needsInit,
    needsInstall,
    needsAttention: needsInit || needsInstall,
  };
}

function buildShortcutLine(route: AppRoute, commitCount: number): string {
  const parts = ["↑/↓ 页面", "←/→ 操作", "Enter/a 执行", "r 刷新"];

  if ((route.kind === "commits" || route.kind === "commit-detail") && commitCount > 1) {
    parts.push("[ ] 提交");
  }

  parts.push("q 退出");
  return parts.join("  ");
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

function summaryLineColor(tone: SnapshotTone, line: string): "white" | "yellow" | "red" | "gray" {
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

function reportToneToBorder(tone: ReportTone): "blue" | "green" | "yellow" | "red" {
  if (tone === "success") {
    return "green";
  }

  if (tone === "warn") {
    return "yellow";
  }

  if (tone === "error") {
    return "red";
  }

  return "blue";
}

function reportToneToSummaryTone(tone: ReportTone): SnapshotTone {
  if (tone === "error") {
    return "fail";
  }

  if (tone === "warn") {
    return "warn";
  }

  return "ok";
}

function Badge({ color, label }: { color: "green" | "yellow" | "red" | "blue"; label: string }) {
  return (
    <Text color="black" backgroundColor={color}>
      {" "}{label}{" "}
    </Text>
  );
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number") {
    return "未知";
  }

  return `${value.toFixed(1)}%`;
}

function formatFastForward(value: boolean | null | undefined): string {
  if (value === true) {
    return "可以";
  }

  if (value === false) {
    return "不可以";
  }

  return "未知";
}
