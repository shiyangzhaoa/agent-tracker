import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const AGENT_TRACKER_HOOK_COMMAND = "./hooks/agent-tracker-hook.sh";
const REQUIRED_HOOK_EVENTS = [
  "afterFileEdit",
  "afterTabFileEdit",
  "afterShellExecution",
  "sessionStart",
  "sessionEnd",
] as const;

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

export function inspectCursorIntegration(repoRoot: string): CursorIntegrationStatus {
  const cursorDirPath = join(repoRoot, ".cursor");
  const hooksJsonPath = join(cursorDirPath, "hooks.json");
  const hooksDirPath = join(cursorDirPath, "hooks");
  const hookScriptPath = join(hooksDirPath, "agent-tracker-hook.sh");
  const hooksJsonExists = existsSync(hooksJsonPath);
  const hookScriptExists = existsSync(hookScriptPath);

  let validConfig = false;
  let managedEvents: string[] = [];

  if (hooksJsonExists) {
    const config = readHooksConfigSync(hooksJsonPath);
    if (config) {
      validConfig = true;
      managedEvents = REQUIRED_HOOK_EVENTS.filter((eventName) =>
        (config.hooks[eventName] ?? []).some((hook) => hook.command === AGENT_TRACKER_HOOK_COMMAND)
      );
    }
  }

  return {
    cursorDirPath,
    hooksJsonPath,
    hooksDirPath,
    hookScriptPath,
    installed: validConfig && hookScriptExists && managedEvents.length === REQUIRED_HOOK_EVENTS.length,
    hooksJsonExists,
    hookScriptExists,
    validConfig,
    managedEvents,
  };
}

export async function installCursorHooks(repoRoot: string): Promise<InstallCursorHooksResult> {
  const cursorDirPath = join(repoRoot, ".cursor");
  const hooksJsonPath = join(cursorDirPath, "hooks.json");
  const hooksDirPath = join(cursorDirPath, "hooks");
  const hookScriptPath = join(hooksDirPath, "agent-tracker-hook.sh");

  await mkdir(hooksDirPath, { recursive: true });

  const hooksJsonExists = existsSync(hooksJsonPath);
  const existingConfig = hooksJsonExists ? await readHooksConfig(hooksJsonPath) : createEmptyHooksConfig();
  const mergedConfig = mergeAgentTrackerHooks(existingConfig);
  const nextContents = `${JSON.stringify(mergedConfig, null, 2)}\n`;
  const previousContents = hooksJsonExists ? await readFile(hooksJsonPath, "utf8") : null;
  const updatedHooksJson = previousContents !== nextContents;

  if (updatedHooksJson) {
    await writeFile(hooksJsonPath, nextContents, "utf8");
  }

  const hookScriptContents = createHookScript();
  let wroteHookScript = true;
  if (existsSync(hookScriptPath)) {
    const previousScript = await readFile(hookScriptPath, "utf8");
    wroteHookScript = previousScript !== hookScriptContents;
  }

  if (wroteHookScript) {
    await mkdir(dirname(hookScriptPath), { recursive: true });
    await writeFile(hookScriptPath, hookScriptContents, "utf8");
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

  for (const eventName of REQUIRED_HOOK_EVENTS) {
    const existingHooks = nextConfig.hooks[eventName] ?? [];

    if (!existingHooks.some((hook) => hook.command === AGENT_TRACKER_HOOK_COMMAND)) {
      nextConfig.hooks[eventName] = [...existingHooks, { command: AGENT_TRACKER_HOOK_COMMAND }];
    } else {
      nextConfig.hooks[eventName] = existingHooks;
    }
  }

  return nextConfig;
}

async function readHooksConfig(filePath: string): Promise<CursorHooksConfig> {
  const contents = await readFile(filePath, "utf8");
  return parseHooksConfig(contents, filePath);
}

function readHooksConfigSync(filePath: string): CursorHooksConfig | null {
  try {
    const contents = readFileSync(filePath, "utf8");
    return parseHooksConfig(contents, filePath);
  } catch {
    return null;
  }
}

function parseHooksConfig(contents: string, filePath: string): CursorHooksConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid Cursor hooks config at ${filePath}: expected an object`);
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`Unsupported Cursor hooks config version in ${filePath}: expected version 1`);
  }

  const hooksValue = record.hooks;
  if (!hooksValue || typeof hooksValue !== "object" || Array.isArray(hooksValue)) {
    throw new Error(`Invalid Cursor hooks config at ${filePath}: "hooks" must be an object`);
  }

  const hooks: Record<string, Array<{ command: string }>> = {};

  for (const [eventName, entries] of Object.entries(hooksValue as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid Cursor hooks config at ${filePath}: hook list for "${eventName}" must be an array`);
    }

    hooks[eventName] = entries
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .filter((entry): entry is { command: string } => typeof entry.command === "string")
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

function createHookScript(): string {
  return `#!/bin/sh
set +e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
DIST_ENTRY="$REPO_ROOT/dist/index.js"
DEV_ENTRY="$REPO_ROOT/src/bin.ts"

cd "$REPO_ROOT" || exit 0

if [ -f "$DIST_ENTRY" ]; then
  bun "$DIST_ENTRY" collect cursor hook
elif [ -f "$DEV_ENTRY" ]; then
  bun "$DEV_ENTRY" collect cursor hook
elif command -v agent-tracker >/dev/null 2>&1; then
  agent-tracker collect cursor hook
fi

exit 0
`;
}
