import { existsSync } from "node:fs";

import { buildBranchDataSummary } from "../lib/branch-data";
import { getConfigPaths, loadConfig, resolveStatePaths } from "../lib/config";
import { inspectCursorIntegration } from "../lib/cursor";
import {
  compareBranches,
  getRepoContext,
  getWorkingTreeSummary,
  GitCommandError,
} from "../lib/git";
import { summarizeRawTraces } from "../lib/storage";
import { formatPath, printSection, printStatus, printSubItem } from "../lib/ui";

export async function runDoctor(cwd: string): Promise<number> {
  console.log("健康检查");

  let repo;

  try {
    repo = getRepoContext(cwd);
  } catch (error) {
    printSection("仓库");
    if (error instanceof GitCommandError) {
      printStatus("fail", "当前目录不是 Git 仓库");
      printSubItem(error.message);
      printSubItem("请在 Git 仓库根目录或其子目录中运行。");
    } else {
      printStatus("fail", "检查当前仓库失败");
      printSubItem(error instanceof Error ? error.message : String(error));
    }

    return 1;
  }

  const loadedConfig = await loadConfig(repo);
  const configPaths = getConfigPaths(repo);
  const statePaths = resolveStatePaths(repo.repoRoot, loadedConfig.config.storageRoot);
  const cursorStatus = inspectCursorIntegration(repo.repoRoot);
  const rawSummary = await summarizeRawTraces(statePaths);
  const workingTree = getWorkingTreeSummary(repo.repoRoot);
  const branchComparison = compareBranches(
    repo.repoRoot,
    loadedConfig.config.sourceBranch,
    loadedConfig.config.targetBranch,
  );
  const branchData = branchComparison.sourceRef && branchComparison.targetRef
    ? await buildBranchDataSummary({
        repoRoot: repo.repoRoot,
        statePaths,
        sourceBranch: loadedConfig.config.sourceBranch,
        targetBranch: loadedConfig.config.targetBranch,
        sourceRef: branchComparison.sourceRef,
        targetRef: branchComparison.targetRef,
        selfEmails: loadedConfig.config.selfEmails,
        selfNames: loadedConfig.config.selfNames,
      })
    : null;

  let failureCount = 0;
  let warningCount = 0;
  const nextSteps = new Set<string>();

  printSection("仓库");
  printStatus("ok", "已识别到 Git 仓库");
  printSubItem(`根目录: ${formatPath(repo.repoRoot)}`);
  printSubItem(`Git 目录: ${formatPath(repo.gitDir)}`);
  printSubItem(`当前分支: ${repo.currentBranch ?? "HEAD（分离状态）"}`);
  if (repo.originUrl) {
    printSubItem(`远端 origin: ${repo.originUrl}`);
  }

  printSection("配置");
  if (loadedConfig.projectConfigExists) {
    printStatus("ok", "已找到项目配置");
  } else {
    printStatus("warn", "未找到项目配置");
    printSubItem(`预期路径: ${formatPath(configPaths.projectConfigPath)}`);
    nextSteps.add("请在“设置”页执行“初始化仓库”。");
    warningCount += 1;
  }
  printSubItem(`当前分支: ${loadedConfig.config.sourceBranch}（自动读取）`);
  printSubItem(`target_branch: ${loadedConfig.config.targetBranch} (${loadedConfig.sources.targetBranch})`);
  printSubItem(`storage_root: ${loadedConfig.config.storageRoot} (${loadedConfig.sources.storageRoot})`);

  if (loadedConfig.localConfigExists) {
    printStatus("ok", "已找到本地覆盖配置");
    printSubItem(`路径: ${formatPath(configPaths.localConfigPath)}`);
  } else {
    printStatus("info", "未找到本地覆盖配置");
    printSubItem(`可选路径: ${formatPath(configPaths.localConfigPath)}`);
  }

  printSection("本地状态");
  if (existsSync(statePaths.storageRoot)) {
    printStatus("ok", "本地状态目录存在");
  } else {
    printStatus("warn", "本地状态目录缺失");
    nextSteps.add("请在“设置”页执行“初始化仓库”。");
    warningCount += 1;
  }
  printSubItem(`存储根目录: ${formatPath(statePaths.storageRoot)}`);
  printSubItem(`Raw Trace 文件数: ${rawSummary.fileCount}`);
  printSubItem(`Raw Trace 事件数: ${rawSummary.eventCount}`);
  if (rawSummary.eventCount === 0) {
    printStatus("info", "当前还没有采集到 Trace 数据");
    printSubItem("在 Cursor Hook 完成安装并实际触发前，这是正常现象。");
  }

  printSection("Cursor");
  if (cursorStatus.installed) {
    printStatus("ok", "agent-tracker 的 Cursor Hooks 已安装");
    printSubItem(`接管事件: ${cursorStatus.managedEvents.join(", ")}`);
  } else {
    printStatus("warn", "agent-tracker 的 Cursor Hooks 尚未完整安装");
    printSubItem(`预期 hooks.json: ${formatPath(cursorStatus.hooksJsonPath)}`);
    if (cursorStatus.hooksJsonExists && !cursorStatus.validConfig) {
      printSubItem("hooks.json 已存在，但无法解析为当前支持的 Cursor Hooks 配置");
    } else if (cursorStatus.hooksJsonExists) {
      printSubItem(`当前检测到的接管事件: ${cursorStatus.managedEvents.join(", ") || "无"}`);
    }
    printSubItem("请在“设置”页执行“安装 Cursor 集成”来安装或修复。");
    warningCount += 1;
    nextSteps.add("请在“设置”页执行“安装 Cursor 集成”。");
  }

  printSection("Git 检查");
  if (workingTree.isDirty) {
    printStatus("info", `工作区还有 ${workingTree.entryCount} 处未提交修改`);
  } else {
    printStatus("ok", "工作区是干净的");
  }

  if (!branchComparison.sourceRef) {
    printStatus("fail", `无法解析当前分支: ${loadedConfig.config.sourceBranch}`);
    nextSteps.add("请确认当前分支存在，或者先切换到需要统计的分支。");
    failureCount += 1;
  } else {
    printStatus("ok", `当前分支已解析: ${loadedConfig.config.sourceBranch}`);
    printSubItem(`引用: ${branchComparison.sourceRef}`);
  }

  if (!branchComparison.targetRef) {
    printStatus("fail", `无法解析目标分支: ${loadedConfig.config.targetBranch}`);
    nextSteps.add("请先 fetch、创建目标分支，或更新配置中的 `target_branch`。");
    failureCount += 1;
  } else {
    printStatus("ok", `目标分支已解析: ${loadedConfig.config.targetBranch}`);
    printSubItem(`引用: ${branchComparison.targetRef}`);
  }

  if (branchComparison.sourceRef && branchComparison.targetRef) {
    printSubItem(`领先提交数: ${branchComparison.ahead}`);
    printSubItem(`落后提交数: ${branchComparison.behind}`);

    if (branchComparison.canFastForward === true) {
      printStatus("ok", "当前可以进行 Fast-forward 对比");
    } else if (branchComparison.canFastForward === false) {
      printStatus("warn", "当前无法进行 Fast-forward 对比");
      printSubItem("在相信分支级统计之前，请先把当前分支同步到目标分支");
      nextSteps.add(
        `请先同步 \`${loadedConfig.config.sourceBranch}\` 和 \`${loadedConfig.config.targetBranch}\`，再查看分支级统计。`,
      );
      warningCount += 1;
    } else {
      printStatus("warn", "暂时无法判断是否可 Fast-forward 对比");
      printSubItem(branchComparison.message ?? "未知 Git 对比错误");
      warningCount += 1;
    }
  }

  if (branchData) {
    printSection("分支数据");
    if (branchData.commitCount === 0) {
      printStatus("info", "当前来源分支与目标分支之间还没有新增 commit");
    } else {
      printStatus("ok", `当前范围内共有 ${branchData.commitCount} 个 commit`);
      printSubItem(`自己提交: ${branchData.selfCommitCount}`);
      printSubItem(`他人提交: ${branchData.teammateCommitCount}`);
      printSubItem(`变更文件总数: ${branchData.filesChanged}`);
      printSubItem(`新增行数: ${branchData.additions}`);
      printSubItem(`删除行数: ${branchData.deletions}`);
      printSubItem(`观测到 Cursor 覆盖的文件: ${branchData.observedAiFiles}`);
      printSubItem(`未知文件: ${branchData.unknownFiles}`);
      printSubItem(
        `文件覆盖度: ${formatPercent(branchData.observedFileCoveragePercent)}`,
      );
      printSubItem(
        `新增行覆盖度: ${formatPercent(branchData.observedAdditionCoveragePercent)}`,
      );
      if (branchData.rawTraceEventsConsidered === 0) {
        printStatus("info", "当前还没有可用于 commit 关联的 Cursor 文件编辑事件");
      } else {
        printSubItem(`参与聚合的 Cursor 文件事件: ${branchData.rawTraceEventsConsidered}`);
      }
      if (branchData.rawTraceInvalidLines > 0) {
        printStatus("warn", `Raw Trace 中有 ${branchData.rawTraceInvalidLines} 行无法解析`);
        warningCount += 1;
      }

      const recentCommits = branchData.recentCommits.slice(0, 3);
      if (recentCommits.length > 0) {
        printSubItem("最近 commit：");
        for (const commit of recentCommits) {
          printSubItem(
            `- ${commit.shortSha} ${commit.subject} | ${commit.authorName} | 文件覆盖 ${formatPercent(commit.observedFileCoveragePercent)}`,
            2,
          );
        }
      }
    }
  }

  printSection("汇总");
  if (failureCount === 0 && warningCount === 0) {
    printStatus("ok", "以当前已实现的能力来看，仓库状态正常");
  } else {
    printStatus(
      failureCount > 0 ? "fail" : "warn",
      `检查完成：${failureCount} 个失败，${warningCount} 个警告`,
    );
  }

  if (nextSteps.size > 0) {
    printSubItem("建议下一步：");
    for (const step of nextSteps) {
      printSubItem(`- ${step}`, 2);
    }
  }

  return failureCount > 0 ? 1 : 0;
}

function formatPercent(value: number | null): string {
  return value === null ? "未知" : `${value.toFixed(1)}%`;
}
