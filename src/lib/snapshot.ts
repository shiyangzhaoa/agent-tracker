import { existsSync } from "node:fs";

import { buildBranchDataSummary, type BranchDataSummary } from "./branch-data";
import { getConfigPaths, loadConfig, resolveStatePaths } from "./config";
import { inspectCursorIntegration } from "./cursor";
import {
  compareBranches,
  getRepoContext,
  getWorkingTreeSummary,
  GitCommandError,
} from "./git";
import { summarizeRawTraces } from "./storage";
import { syncTraceIndex } from "./trace-index";

export type SnapshotTone = "ok" | "warn" | "fail";

export interface AppSnapshot {
  available: boolean;
  tone: SnapshotTone;
  summary: string;
  repoRoot?: string;
  gitDir?: string;
  currentBranch?: string | null;
  originUrl?: string | null;
  sourceBranch?: string;
  targetBranch?: string;
  projectConfigExists?: boolean;
  localConfigExists?: boolean;
  projectConfigPath?: string;
  localConfigPath?: string;
  storageRoot?: string;
  storageRootExists?: boolean;
  rawTraceFiles?: number;
  rawTraceEvents?: number;
  normalizedTraceEvents?: number;
  normalizedFileEditEvents?: number;
  fileSnapshots?: number;
  cursorInstalled?: boolean;
  cursorManagedEvents?: string[];
  hooksJsonPath?: string;
  dirtyCount?: number;
  ahead?: number | null;
  behind?: number | null;
  canFastForward?: boolean | null;
  branchData?: BranchDataSummary;
  issues: string[];
}

export async function getAppSnapshot(cwd: string): Promise<AppSnapshot> {
  let repo;

  try {
    repo = getRepoContext(cwd);
  } catch (error) {
    if (error instanceof GitCommandError) {
      return {
        available: false,
        tone: "fail",
        summary: "当前目录不是 Git 仓库",
        issues: [error.message],
      };
    }

    return {
      available: false,
      tone: "fail",
      summary: "检查当前仓库失败",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }

  const loadedConfig = await loadConfig(repo);
  const configPaths = getConfigPaths(repo);
  const statePaths = resolveStatePaths(repo.repoRoot, loadedConfig.config.storageRoot);
  const rawSummary = await summarizeRawTraces(statePaths);
  const traceIndexSummary = await syncTraceIndex(statePaths);
  const cursorStatus = inspectCursorIntegration(repo.repoRoot);
  const workingTree = getWorkingTreeSummary(repo.repoRoot);
  const branchComparison = compareBranches(
    repo.repoRoot,
    loadedConfig.config.sourceBranch,
    loadedConfig.config.targetBranch,
  );

  let tone: SnapshotTone = "ok";
  const issues: string[] = [];
  let branchData: BranchDataSummary | undefined;

  if (!loadedConfig.projectConfigExists) {
    tone = "warn";
    issues.push("项目配置尚未创建。");
  }

  const storageRootExists = existsSync(statePaths.storageRoot);
  if (!storageRootExists) {
    tone = "warn";
    issues.push("本地状态目录缺失。");
  }

  if (!cursorStatus.installed) {
    tone = "warn";
    issues.push("Cursor 集成尚未安装。");
  }

  const hasBranchResolutionFailure = !branchComparison.sourceRef || !branchComparison.targetRef;

  if (hasBranchResolutionFailure) {
    tone = "fail";
    issues.push("来源分支或目标分支无法解析。");
    if (branchComparison.message) {
      issues.push(branchComparison.message);
    }
  } else if (branchComparison.canFastForward === false) {
    tone = "warn";
    issues.push("当前分支与目标分支不满足 Fast-forward 条件。");
  } else if (branchComparison.canFastForward === null && branchComparison.message) {
    tone = "warn";
    issues.push(branchComparison.message);
  }

  if (branchComparison.sourceRef && branchComparison.targetRef) {
    branchData = await buildBranchDataSummary({
      repoRoot: repo.repoRoot,
      statePaths,
      sourceBranch: loadedConfig.config.sourceBranch,
      targetBranch: loadedConfig.config.targetBranch,
      sourceRef: branchComparison.sourceRef,
      targetRef: branchComparison.targetRef,
      selfEmails: loadedConfig.config.selfEmails,
      selfNames: loadedConfig.config.selfNames,
    });

    if (branchData.commitCount > 0 && branchData.observedAiFiles === 0) {
      tone = tone === "fail" ? "fail" : "warn";
      issues.push("当前分支范围内还没有观测到可关联到 commit 的 Cursor 文件编辑事件。");
    }

    if (branchData.rawTraceInvalidLines > 0) {
      tone = tone === "fail" ? "fail" : "warn";
      issues.push(`Raw Trace 中有 ${branchData.rawTraceInvalidLines} 行无法解析。`);
    }
  }

  const summary =
    tone === "ok"
      ? "以当前已实现的能力来看，仓库已经准备好进行设置和采集。"
      : tone === "warn"
        ? "仓库还有一些需要处理的地方，处理后整体体验会更稳定。"
        : "仓库存在阻塞性问题，建议先修复再继续。";

  return {
    available: true,
    tone,
    summary,
    repoRoot: repo.repoRoot,
    gitDir: repo.gitDir,
    currentBranch: repo.currentBranch,
    originUrl: repo.originUrl,
    sourceBranch: loadedConfig.config.sourceBranch,
    targetBranch: loadedConfig.config.targetBranch,
    projectConfigExists: loadedConfig.projectConfigExists,
    localConfigExists: loadedConfig.localConfigExists,
    projectConfigPath: configPaths.projectConfigPath,
    localConfigPath: configPaths.localConfigPath,
    storageRoot: statePaths.storageRoot,
    storageRootExists,
    rawTraceFiles: rawSummary.fileCount,
    rawTraceEvents: rawSummary.eventCount,
    normalizedTraceEvents: traceIndexSummary.normalizedEventCount,
    normalizedFileEditEvents: traceIndexSummary.normalizedFileEditCount,
    fileSnapshots: traceIndexSummary.fileSnapshotCount,
    cursorInstalled: cursorStatus.installed,
    cursorManagedEvents: cursorStatus.managedEvents,
    hooksJsonPath: cursorStatus.hooksJsonPath,
    dirtyCount: workingTree.entryCount,
    ahead: branchComparison.ahead,
    behind: branchComparison.behind,
    canFastForward: branchComparison.canFastForward,
    branchData,
    issues,
  };
}
