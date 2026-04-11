import { mkdir } from "node:fs/promises";

import {
  createDefaultProjectConfig,
  getConfigPaths,
  loadConfig,
  resolveStatePaths,
} from "../lib/config";
import { inspectCursorIntegration, installCursorHooks } from "../lib/cursor";
import { getRepoContext, GitCommandError } from "../lib/git";
import { ensureStateLayout } from "../lib/storage";
import { formatPath, printSection, printStatus, printSubItem } from "../lib/ui";

export async function runCollectCursorInstall(cwd: string): Promise<number> {
  console.log("安装 Cursor 集成");

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

  const configPaths = getConfigPaths(repo);
  await mkdir(configPaths.projectConfigDir, { recursive: true });

  const createdProjectConfig = await createDefaultProjectConfig(repo);
  const loadedConfig = await loadConfig(repo);
  const statePaths = resolveStatePaths(repo.repoRoot, loadedConfig.config.storageRoot);
  const layoutResult = await ensureStateLayout(statePaths);
  const installResult = await installCursorHooks(repo.repoRoot);
  const cursorStatus = inspectCursorIntegration(repo.repoRoot);

  printSection("仓库");
  printStatus("ok", "已识别到 Git 仓库");
  printSubItem(`根目录: ${formatPath(repo.repoRoot)}`);
  printSubItem(`当前分支: ${repo.currentBranch ?? "HEAD（分离状态）"}`);

  printSection("配置");
  printStatus("ok", createdProjectConfig.created ? "已创建项目配置" : "项目配置已存在");
  printSubItem(`路径: ${formatPath(createdProjectConfig.path)}`);
  printSubItem(`当前分支: ${loadedConfig.config.sourceBranch}（自动读取）`);
  printSubItem(`target_branch: ${loadedConfig.config.targetBranch}`);

  printSection("本地状态");
  printStatus("ok", "本地状态目录已准备完成");
  printSubItem(`存储根目录: ${formatPath(statePaths.storageRoot)}`);
  if (layoutResult.created.length > 0) {
    printSubItem(`新建内容: ${layoutResult.created.join(", ")}`);
  } else {
    printSubItem("新建内容: 无，沿用现有目录");
  }

  printSection("Cursor");
  printStatus("ok", "agent-tracker 的 Hook 集成已安装");
  printSubItem(`hooks.json: ${formatPath(installResult.hooksJsonPath)}`);
  printSubItem(`Hook 脚本: ${formatPath(installResult.hookScriptPath)}`);
  printSubItem(`接管事件: ${installResult.managedEvents.join(", ")}`);
  if (installResult.createdHooksJson) {
    printSubItem("hooks.json 处理结果: 已创建");
  } else if (installResult.updatedHooksJson) {
    printSubItem("hooks.json 处理结果: 已原地更新");
  } else {
    printSubItem("hooks.json 处理结果: 已是最新");
  }
  if (installResult.wroteHookScript) {
    printSubItem("Hook 脚本处理结果: 已写入或更新");
  } else {
    printSubItem("Hook 脚本处理结果: 已是最新");
  }

  printSection("校验");
  if (cursorStatus.installed) {
    printStatus("ok", "Cursor 集成当前状态正常");
  } else {
    printStatus("warn", "Cursor 集成已写入，但校验仍不完整");
    if (!cursorStatus.validConfig) {
      printSubItem("hooks.json 已存在，但暂时无法通过校验");
    }
    if (cursorStatus.managedEvents.length < installResult.managedEvents.length) {
      printSubItem(
        `检测到的接管事件: ${cursorStatus.managedEvents.join(", ") || "无"}`,
      );
    }
  }

  printSection("下一步");
  printStatus("info", "后续只需正常使用 Cursor，Hook 事件会被写入本地 Raw Trace");
  printStatus("info", "在 Cursor 编辑后，请打开“健康”页确认 Trace 文件是否开始增长");

  return 0;
}
