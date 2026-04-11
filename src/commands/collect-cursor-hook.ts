import {
  createDefaultProjectConfig,
  loadConfig,
  resolveStatePaths,
} from '../lib/config';
import { getRepoContext } from '../lib/git';
import { createCursorRawTraceRecord } from '../lib/raw-trace';
import {
  appendFileSnapshot,
  appendHookErrorLog,
  appendRawTraceEvent,
  ensureStateLayout,
} from '../lib/storage';

export async function runCollectCursorHook(
  cwd: string,
  argv: string[] = [],
): Promise<number> {
  try {
    const repo = getRepoContext(cwd);
    await createDefaultProjectConfig(repo);

    const loadedConfig = await loadConfig(repo);
    const statePaths = resolveStatePaths(
      repo.repoRoot,
      loadedConfig.config.storageRoot,
      repo.gitDir,
    );
    await ensureStateLayout(statePaths);

    const inputText = await readHookPayloadText(argv);
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
      const statePaths = resolveStatePaths(
        repo.repoRoot,
        loadedConfig.config.storageRoot,
        repo.gitDir,
      );
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

async function readHookPayloadText(argv: string[]): Promise<string> {
  const stdinText = (await Bun.stdin.text()).trim();
  if (stdinText) {
    return stdinText;
  }

  const argPayload = argv
    .map((value) => value.trim())
    .find((value) => value.startsWith('{') || value.startsWith('['));
  if (argPayload) {
    return argPayload;
  }

  const envPayload = buildHookPayloadFromEnv(Bun.env);
  return envPayload ? JSON.stringify(envPayload) : '';
}

function buildHookPayloadFromEnv(
  env: Record<string, string | undefined>,
): Record<string, unknown> | null {
  const hookEventName = firstDefined(env, [
    'CURSOR_HOOK_EVENT_NAME',
    'HOOK_EVENT_NAME',
    'EVENT_NAME',
  ]);
  const filePath = firstDefined(env, [
    'CURSOR_FILE_PATH',
    'FILE_PATH',
    'PATH_TO_FILE',
  ]);
  const toolName = firstDefined(env, ['CURSOR_TOOL_NAME', 'TOOL_NAME']);
  const recordedAt = firstDefined(env, [
    'CURSOR_RECORDED_AT',
    'RECORDED_AT',
    'TIMESTAMP',
  ]);
  const model = firstDefined(env, ['CURSOR_MODEL', 'MODEL']);
  const sessionId = firstDefined(env, ['CURSOR_SESSION_ID', 'SESSION_ID']);
  const conversationId = firstDefined(env, [
    'CURSOR_CONVERSATION_ID',
    'CONVERSATION_ID',
  ]);
  const generationId = firstDefined(env, [
    'CURSOR_GENERATION_ID',
    'GENERATION_ID',
  ]);
  const toolInputText = firstDefined(env, ['CURSOR_TOOL_INPUT', 'TOOL_INPUT']);

  const toolInput = parseJsonObject(toolInputText);
  const payload: Record<string, unknown> = {};

  if (hookEventName) {
    payload.hook_event_name = hookEventName;
  }
  if (filePath) {
    payload.file_path = filePath;
  }
  if (toolName) {
    payload.tool_name = toolName;
  }
  if (toolInput) {
    payload.tool_input = toolInput;
  }
  if (recordedAt) {
    payload.recorded_at = recordedAt;
  }
  if (model) {
    payload.model = model;
  }
  if (sessionId) {
    payload.session_id = sessionId;
  }
  if (conversationId) {
    payload.conversation_id = conversationId;
  }
  if (generationId) {
    payload.generation_id = generationId;
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

function parseJsonObject(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function firstDefined(
  env: Record<string, string | undefined>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}
