import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_TRACKER_HOOK_COMMAND = '.cursor/hooks/agent-tracker-hook.sh';
const REQUIRED_HOOK_EVENTS = [
  'afterFileEdit',
  'afterTabFileEdit',
  'afterShellExecution',
  'postToolUse',
  'sessionStart',
  'sessionEnd',
] as const;

const LEGACY_HOOK_EVENT_RENAMES: Readonly<Record<string, string>> = {
  PostToolUse: 'postToolUse',
};

const LEGACY_HOOK_COMMANDS = new Set([
  './hooks/agent-tracker-hook.sh',
  './.cursor/hooks/agent-tracker-hook.sh',
]);

export interface CursorIntegrationStatus {
  cursorDirPath: string;
  hooksJsonPath: string;
  hooksDirPath: string;
  hookScriptPath: string;
  installed: boolean;
  hooksJsonExists: boolean;
  hookScriptExists: boolean;
  validConfig: boolean;
  managedEvents: string[];
}

interface CursorHooksConfig {
  version: number;
  hooks: Record<string, Array<{ command: string }>>;
}

export interface InstallCursorHooksResult {
  hooksJsonPath: string;
  hookScriptPath: string;
  createdHooksJson: boolean;
  updatedHooksJson: boolean;
  wroteHookScript: boolean;
  managedEvents: string[];
}

interface HookLauncher {
  runtimePath: string | null;
  entryPath: string | null;
}

export function inspectCursorIntegration(
  repoRoot: string,
): CursorIntegrationStatus {
  const cursorDirPath = join(repoRoot, '.cursor');
  const hooksJsonPath = join(cursorDirPath, 'hooks.json');
  const hooksDirPath = join(cursorDirPath, 'hooks');
  const hookScriptPath = join(hooksDirPath, 'agent-tracker-hook.sh');
  const hooksJsonExists = existsSync(hooksJsonPath);
  const hookScriptExists = existsSync(hookScriptPath);

  let validConfig = false;
  let managedEvents: string[] = [];

  if (hooksJsonExists) {
    const config = readHooksConfigSync(hooksJsonPath);
    if (config) {
      validConfig = true;
      managedEvents = REQUIRED_HOOK_EVENTS.filter((eventName) =>
        (config.hooks[eventName] ?? []).some((hook) =>
          isAgentTrackerHookCommand(hook.command),
        ),
      );
    }
  }

  return {
    cursorDirPath,
    hooksJsonPath,
    hooksDirPath,
    hookScriptPath,
    installed:
      validConfig &&
      hookScriptExists &&
      managedEvents.length === REQUIRED_HOOK_EVENTS.length,
    hooksJsonExists,
    hookScriptExists,
    validConfig,
    managedEvents,
  };
}

export async function installCursorHooks(
  repoRoot: string,
): Promise<InstallCursorHooksResult> {
  const cursorDirPath = join(repoRoot, '.cursor');
  const hooksJsonPath = join(cursorDirPath, 'hooks.json');
  const hooksDirPath = join(cursorDirPath, 'hooks');
  const hookScriptPath = join(hooksDirPath, 'agent-tracker-hook.sh');
  const launcher = resolveHookLauncher();

  await mkdir(hooksDirPath, { recursive: true });

  const hooksJsonExists = existsSync(hooksJsonPath);
  const existingConfig = hooksJsonExists
    ? await readHooksConfig(hooksJsonPath)
    : createEmptyHooksConfig();
  const mergedConfig = mergeAgentTrackerHooks(existingConfig);
  const nextContents = `${JSON.stringify(mergedConfig, null, 2)}\n`;
  const previousContents = hooksJsonExists
    ? await readFile(hooksJsonPath, 'utf8')
    : null;
  const updatedHooksJson = previousContents !== nextContents;

  if (updatedHooksJson) {
    await writeFile(hooksJsonPath, nextContents, 'utf8');
  }

  const hookScriptContents = createHookScript(launcher);
  let wroteHookScript = true;
  if (existsSync(hookScriptPath)) {
    const previousScript = await readFile(hookScriptPath, 'utf8');
    wroteHookScript = previousScript !== hookScriptContents;
  }

  if (wroteHookScript) {
    await mkdir(dirname(hookScriptPath), { recursive: true });
    await writeFile(hookScriptPath, hookScriptContents, 'utf8');
  }
  await chmod(hookScriptPath, 0o755);

  return {
    hooksJsonPath,
    hookScriptPath,
    createdHooksJson: !hooksJsonExists,
    updatedHooksJson,
    wroteHookScript,
    managedEvents: [...REQUIRED_HOOK_EVENTS],
  };
}

function mergeAgentTrackerHooks(config: CursorHooksConfig): CursorHooksConfig {
  const nextConfig = {
    version: config.version,
    hooks: { ...config.hooks },
  };

  for (const [eventName, hooks] of Object.entries(nextConfig.hooks)) {
    nextConfig.hooks[eventName] = normalizeAgentTrackerHookCommands(hooks);
  }

  for (const [legacyEventName, nextEventName] of Object.entries(
    LEGACY_HOOK_EVENT_RENAMES,
  )) {
    const legacyHooks = nextConfig.hooks[legacyEventName] ?? [];
    if (legacyHooks.length === 0) {
      continue;
    }

    const nextHooks = nextConfig.hooks[nextEventName] ?? [];
    const mergedHooks = [...nextHooks];

    for (const hook of legacyHooks) {
      if (
        !mergedHooks.some(
          (existingHook) => existingHook.command === hook.command,
        )
      ) {
        mergedHooks.push(hook);
      }
    }

    nextConfig.hooks[nextEventName] = mergedHooks;
    delete nextConfig.hooks[legacyEventName];
  }

  for (const eventName of REQUIRED_HOOK_EVENTS) {
    const existingHooks = nextConfig.hooks[eventName] ?? [];

    if (
      !existingHooks.some((hook) => hook.command === AGENT_TRACKER_HOOK_COMMAND)
    ) {
      nextConfig.hooks[eventName] = [
        ...existingHooks,
        { command: AGENT_TRACKER_HOOK_COMMAND },
      ];
    } else {
      nextConfig.hooks[eventName] = existingHooks;
    }
  }

  return nextConfig;
}

async function readHooksConfig(filePath: string): Promise<CursorHooksConfig> {
  const contents = await readFile(filePath, 'utf8');
  return parseHooksConfig(contents, filePath);
}

function readHooksConfigSync(filePath: string): CursorHooksConfig | null {
  try {
    const contents = readFileSync(filePath, 'utf8');
    return parseHooksConfig(contents, filePath);
  } catch {
    return null;
  }
}

function parseHooksConfig(
  contents: string,
  filePath: string,
): CursorHooksConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `Invalid Cursor hooks config at ${filePath}: expected an object`,
    );
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(
      `Unsupported Cursor hooks config version in ${filePath}: expected version 1`,
    );
  }

  const hooksValue = record.hooks;
  if (
    !hooksValue ||
    typeof hooksValue !== 'object' ||
    Array.isArray(hooksValue)
  ) {
    throw new Error(
      `Invalid Cursor hooks config at ${filePath}: "hooks" must be an object`,
    );
  }

  const hooks: Record<string, Array<{ command: string }>> = {};

  for (const [eventName, entries] of Object.entries(
    hooksValue as Record<string, unknown>,
  )) {
    if (!Array.isArray(entries)) {
      throw new Error(
        `Invalid Cursor hooks config at ${filePath}: hook list for "${eventName}" must be an array`,
      );
    }

    hooks[eventName] = entries
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object',
      )
      .filter(
        (entry): entry is { command: string } =>
          typeof entry.command === 'string',
      )
      .map((entry) => ({ command: entry.command }));
  }

  return {
    version: 1,
    hooks,
  };
}

function createEmptyHooksConfig(): CursorHooksConfig {
  return {
    version: 1,
    hooks: {},
  };
}

function normalizeAgentTrackerHookCommands(
  hooks: Array<{ command: string }>,
): Array<{ command: string }> {
  const normalizedHooks: Array<{ command: string }> = [];

  for (const hook of hooks) {
    const command = isAgentTrackerHookCommand(hook.command)
      ? AGENT_TRACKER_HOOK_COMMAND
      : hook.command;

    if (
      !normalizedHooks.some((existingHook) => existingHook.command === command)
    ) {
      normalizedHooks.push({ command });
    }
  }

  return normalizedHooks;
}

function isAgentTrackerHookCommand(command: string): boolean {
  return (
    command === AGENT_TRACKER_HOOK_COMMAND || LEGACY_HOOK_COMMANDS.has(command)
  );
}

function createHookScript(launcher: HookLauncher): string {
  const runtimePath = launcher.runtimePath
    ? shellEscape(launcher.runtimePath)
    : '""';
  const entryPath = launcher.entryPath ? shellEscape(launcher.entryPath) : '""';

  return `#!/bin/sh
set +e

SCRIPT_PATH="$0"
case "$SCRIPT_PATH" in
  */*) SCRIPT_DIR="\${SCRIPT_PATH%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
SCRIPT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
TRACKER_RUNTIME=${runtimePath}
TRACKER_ENTRY=${entryPath}

cd "$REPO_ROOT" || exit 0

if [ -n "$TRACKER_RUNTIME" ] && [ -n "$TRACKER_ENTRY" ] && [ -x "$TRACKER_RUNTIME" ] && [ -f "$TRACKER_ENTRY" ]; then
  "$TRACKER_RUNTIME" "$TRACKER_ENTRY" collect cursor hook "$@"
elif command -v agent-tracker >/dev/null 2>&1; then
  agent-tracker collect cursor hook "$@"
fi

exit 0
`;
}

function resolveHookLauncher(): HookLauncher {
  const runtimePath =
    typeof process.execPath === 'string' && process.execPath.length > 0
      ? process.execPath
      : null;
  const argvEntry =
    typeof process.argv[1] === 'string' && process.argv[1].length > 0
      ? process.argv[1]
      : null;
  const bunMain =
    typeof Bun.main === 'string' &&
    Bun.main.length > 0 &&
    !Bun.main.endsWith('[eval]')
      ? Bun.main
      : null;
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const packageDistEntry = packageRoot
    ? resolve(packageRoot, 'dist/index.js')
    : null;
  const packageSourceEntry = packageRoot
    ? resolve(packageRoot, 'src/bin.ts')
    : null;
  const entryPath =
    [argvEntry, bunMain, packageDistEntry, packageSourceEntry].find(
      (value): value is string => {
        return (
          typeof value === 'string' && value.length > 0 && existsSync(value)
        );
      },
    ) ?? null;

  return {
    runtimePath: runtimePath && existsSync(runtimePath) ? runtimePath : null,
    entryPath,
  };
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function findPackageRoot(startDir: string): string | null {
  let currentDir = startDir;

  for (let index = 0; index < 8; index += 1) {
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}
