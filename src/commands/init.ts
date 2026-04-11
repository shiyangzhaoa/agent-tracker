import { mkdir } from 'node:fs/promises';

import {
  createDefaultProjectConfig,
  getConfigPaths,
  loadConfig,
  resolveStatePaths,
} from '../lib/config';
import { inspectCursorIntegration } from '../lib/cursor';
import { getRepoContext, GitCommandError } from '../lib/git';
import { ensureStateLayout } from '../lib/storage';
import { formatPath, printSection, printStatus, printSubItem } from '../lib/ui';

export async function runInit(cwd: string): Promise<number> {
  console.log('初始化仓库');

  let repo;

  try {
    repo = getRepoContext(cwd);
  } catch (error) {
    printSection('仓库');
    if (error instanceof GitCommandError) {
      printStatus('fail', '当前目录不是 Git 仓库');
      printSubItem(error.message);
      printSubItem('请在 Git 仓库内运行。');
    } else {
      printStatus('fail', '检查当前仓库失败');
      printSubItem(error instanceof Error ? error.message : String(error));
    }

    return 1;
  }

  const configPaths = getConfigPaths(repo);

  printSection('仓库');
  printStatus('ok', '已识别到 Git 仓库');
  printSubItem(`根目录: ${formatPath(repo.repoRoot)}`);
  printSubItem(`Git 目录: ${formatPath(repo.gitDir)}`);
  printSubItem(`当前分支: ${repo.currentBranch ?? 'HEAD（分离状态）'}`);

  await mkdir(configPaths.projectConfigDir, { recursive: true });

  const createdProjectConfig = await createDefaultProjectConfig(repo);
  const loadedConfig = await loadConfig(repo);
  const statePaths = resolveStatePaths(
    repo.repoRoot,
    loadedConfig.config.storageRoot,
    repo.gitDir,
  );
  const layoutResult = await ensureStateLayout(statePaths);
  const cursorStatus = inspectCursorIntegration(repo.repoRoot);

  printSection('配置');
  if (createdProjectConfig.created) {
    printStatus('ok', '已创建项目配置');
  } else {
    printStatus('ok', '项目配置已存在');
  }
  printSubItem(`路径: ${formatPath(createdProjectConfig.path)}`);
  printSubItem(`当前分支: ${loadedConfig.config.sourceBranch}（自动读取）`);
  printSubItem(`target_branch: ${loadedConfig.config.targetBranch}`);
  printSubItem(`storage_root: ${loadedConfig.config.storageRoot}`);

  printSection('本地状态');
  printStatus('ok', '本地状态目录已准备完成');
  printSubItem(`存储根目录: ${formatPath(statePaths.storageRoot)}`);
  printSubItem(`原始 Trace 目录: ${formatPath(statePaths.rawDir)}`);
  printSubItem(`缓存目录: ${formatPath(statePaths.cacheDir)}`);
  printSubItem(`索引占位文件: ${formatPath(statePaths.indexFile)}`);
  if (layoutResult.created.length > 0) {
    printSubItem(`新建内容: ${layoutResult.created.join(', ')}`);
  } else {
    printSubItem('新建内容: 无，沿用现有目录');
  }

  printSection('Cursor');
  if (cursorStatus.installed) {
    printStatus('ok', 'Cursor Hooks 已安装');
    printSubItem(`接管事件: ${cursorStatus.managedEvents.join(', ')}`);
  } else {
    printStatus('warn', 'agent-tracker 的 Cursor Hooks 尚未安装');
    printSubItem(`预期路径: ${formatPath(cursorStatus.hooksJsonPath)}`);
    printSubItem('请在“设置”页中安装 / 修复 Cursor 集成。');
  }

  printSection('下一步');
  printStatus('info', '请打开“健康”页检查仓库状态');
  if (!cursorStatus.installed) {
    printStatus(
      'info',
      '请在“设置”页安装 / 修复 Cursor 集成，之后才能开始采集 Trace',
    );
  }

  return 0;
}
