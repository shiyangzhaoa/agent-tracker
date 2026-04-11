import { createDefaultProjectConfig, loadConfig, resolveStatePaths } from "../lib/config";
import { getRepoContext } from "../lib/git";
import { createCursorRawTraceRecord } from "../lib/raw-trace";
import {
  appendFileSnapshot,
  appendHookErrorLog,
  appendRawTraceEvent,
  ensureStateLayout,
} from "../lib/storage";

export async function runCollectCursorHook(cwd: string): Promise<number> {
  try {
    const repo = getRepoContext(cwd);
    await createDefaultProjectConfig(repo);

    const loadedConfig = await loadConfig(repo);
    const statePaths = resolveStatePaths(repo.repoRoot, loadedConfig.config.storageRoot);
    await ensureStateLayout(statePaths);

    const inputText = (await Bun.stdin.text()).trim();
    if (!inputText) {
      return 0;
    }

    const payload = JSON.parse(inputText) as Record<string, unknown>;
    const record = await createCursorRawTraceRecord(repo, payload);
    await appendRawTraceEvent(statePaths, record.event);
    if (record.snapshot) {
      await appendFileSnapshot(statePaths, record.snapshot);
    }
  } catch (error) {
    try {
      const repo = getRepoContext(cwd);
      const loadedConfig = await loadConfig(repo);
      const statePaths = resolveStatePaths(repo.repoRoot, loadedConfig.config.storageRoot);
      await ensureStateLayout(statePaths);
      await appendHookErrorLog(
        statePaths,
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // Fail open. Hook capture must never block Cursor usage.
    }
  }

  return 0;
}
