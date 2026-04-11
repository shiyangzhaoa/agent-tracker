import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { RepoContext } from './git';

export interface UserConfig {
  targetBranch?: string;
  storageRoot?: string;
  webPort?: number;
  ffCheck?: boolean;
  fetchBeforeCompare?: boolean;
  cursorHooksEnabled?: boolean;
  selfEmails?: string[];
  selfNames?: string[];
  ignore?: string[];
}

export interface EffectiveConfig {
  sourceBranch: string;
  targetBranch: string;
  storageRoot: string;
  webPort: number;
  ffCheck: boolean;
  fetchBeforeCompare: boolean;
  cursorHooksEnabled: boolean;
  selfEmails: string[];
  selfNames: string[];
  ignore: string[];
}

export interface LoadedConfig {
  config: EffectiveConfig;
  sources: Record<keyof EffectiveConfig, string>;
  projectConfigPath: string;
  localConfigPath: string;
  projectConfigExists: boolean;
  localConfigExists: boolean;
  projectConfigMissingKeys: string[];
}

export interface StatePaths {
  storageRoot: string;
  rawDir: string;
  cacheDir: string;
  snapshotsDir: string;
  indexFile: string;
}

const DEFAULTS = {
  targetBranch: 'main',
  storageRoot: '.git/agent-tracker',
  webPort: 3487,
  ffCheck: true,
  fetchBeforeCompare: false,
  cursorHooksEnabled: true,
  selfEmails: [],
  selfNames: [],
  ignore: [
    '**/*.md',
    '**/*.lock',
    '**/bun.lockb',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/npm-shrinkwrap.json',
  ],
} satisfies Omit<EffectiveConfig, 'sourceBranch'>;

const PROJECT_CONFIG_FIELD_MAP = [
  { fileKey: 'target_branch', configKey: 'targetBranch' },
  { fileKey: 'storage_root', configKey: 'storageRoot' },
  { fileKey: 'cursor_hooks_enabled', configKey: 'cursorHooksEnabled' },
  { fileKey: 'ff_check', configKey: 'ffCheck' },
  { fileKey: 'fetch_before_compare', configKey: 'fetchBeforeCompare' },
  { fileKey: 'web_port', configKey: 'webPort' },
  { fileKey: 'self_emails', configKey: 'selfEmails' },
  { fileKey: 'self_names', configKey: 'selfNames' },
  { fileKey: 'ignore', configKey: 'ignore' },
] as const;

type SourceMap = Record<keyof EffectiveConfig, string>;

export function getConfigPaths(repo: RepoContext): {
  projectConfigDir: string;
  projectConfigPath: string;
  localConfigPath: string;
} {
  return {
    projectConfigDir: join(repo.repoRoot, '.agent-tracker'),
    projectConfigPath: join(repo.repoRoot, '.agent-tracker', 'config.toml'),
    localConfigPath: join(repo.gitDir, 'agent-tracker', 'config.local.toml'),
  };
}

export async function createDefaultProjectConfig(repo: RepoContext): Promise<{
  created: boolean;
  path: string;
}> {
  const configPaths = getConfigPaths(repo);

  if (existsSync(configPaths.projectConfigPath)) {
    return { created: false, path: configPaths.projectConfigPath };
  }

  await mkdir(configPaths.projectConfigDir, { recursive: true });
  const template = renderProjectConfigTemplate();
  await writeFile(configPaths.projectConfigPath, template, 'utf8');

  return { created: true, path: configPaths.projectConfigPath };
}

export async function loadConfig(repo: RepoContext): Promise<LoadedConfig> {
  const configPaths = getConfigPaths(repo);
  const projectConfigExists = existsSync(configPaths.projectConfigPath);
  const localConfigExists = existsSync(configPaths.localConfigPath);

  const projectConfig = projectConfigExists
    ? await readConfigFile(configPaths.projectConfigPath)
    : {};
  const localConfig = localConfigExists
    ? await readConfigFile(configPaths.localConfigPath)
    : {};
  const envConfig = readEnvConfig();

  const config: EffectiveConfig = {
    sourceBranch: repo.currentBranch ?? 'HEAD',
    targetBranch: DEFAULTS.targetBranch,
    storageRoot: DEFAULTS.storageRoot,
    webPort: DEFAULTS.webPort,
    ffCheck: DEFAULTS.ffCheck,
    fetchBeforeCompare: DEFAULTS.fetchBeforeCompare,
    cursorHooksEnabled: DEFAULTS.cursorHooksEnabled,
    selfEmails: [...DEFAULTS.selfEmails],
    selfNames: [...DEFAULTS.selfNames],
    ignore: [...DEFAULTS.ignore],
  };

  const sources: SourceMap = {
    sourceBranch: '默认值（当前分支）',
    targetBranch: '默认值',
    storageRoot: '默认值',
    webPort: '默认值',
    ffCheck: '默认值',
    fetchBeforeCompare: '默认值',
    cursorHooksEnabled: '默认值',
    selfEmails: '默认值',
    selfNames: '默认值',
    ignore: '默认值',
  };

  applyConfigLayer(config, sources, projectConfig, '项目配置');
  applyConfigLayer(config, sources, localConfig, '本地覆盖');
  applyConfigLayer(config, sources, envConfig, '环境变量');

  return {
    config,
    sources,
    projectConfigPath: configPaths.projectConfigPath,
    localConfigPath: configPaths.localConfigPath,
    projectConfigExists,
    localConfigExists,
    projectConfigMissingKeys: projectConfigExists
      ? listMissingProjectConfigKeys(projectConfig)
      : [],
  };
}

export function resolveStatePaths(
  repoRoot: string,
  storageRoot: string,
  gitDir?: string,
): StatePaths {
  const resolvedStorageRoot = resolveStorageRoot(repoRoot, storageRoot, gitDir);

  return {
    storageRoot: resolvedStorageRoot,
    rawDir: join(resolvedStorageRoot, 'raw'),
    cacheDir: join(resolvedStorageRoot, 'cache'),
    snapshotsDir: join(resolvedStorageRoot, 'cache', 'snapshots'),
    indexFile: join(resolvedStorageRoot, 'index.sqlite'),
  };
}

function resolveStorageRoot(
  repoRoot: string,
  storageRoot: string,
  gitDir?: string,
): string {
  if (isAbsolute(storageRoot)) {
    return storageRoot;
  }

  if (storageRoot === '.git' || storageRoot.startsWith('.git/')) {
    const gitStorageRoot = gitDir ?? join(repoRoot, '.git');
    const suffix = storageRoot === '.git' ? '' : storageRoot.slice(5);
    return suffix.length > 0 ? join(gitStorageRoot, suffix) : gitStorageRoot;
  }

  return join(repoRoot, storageRoot);
}

function renderProjectConfigTemplate(): string {
  return `# agent-tracker 项目配置
# 这个文件适合随仓库一起共享。

target_branch = "${DEFAULTS.targetBranch}"
storage_root = "${DEFAULTS.storageRoot}"
cursor_hooks_enabled = ${DEFAULTS.cursorHooksEnabled}
ff_check = ${DEFAULTS.ffCheck}
fetch_before_compare = ${DEFAULTS.fetchBeforeCompare}
web_port = ${DEFAULTS.webPort}
self_emails = []
self_names = []
ignore = ${JSON.stringify(DEFAULTS.ignore)}
`;
}

async function readConfigFile(filePath: string): Promise<UserConfig> {
  const contents = await readFile(filePath, 'utf8');
  const parsed = Bun.TOML.parse(contents) as Record<string, unknown>;
  const config: UserConfig = {};

  if (
    typeof parsed.target_branch === 'string' &&
    parsed.target_branch.length > 0
  ) {
    config.targetBranch = parsed.target_branch;
  }
  if (
    typeof parsed.storage_root === 'string' &&
    parsed.storage_root.length > 0
  ) {
    config.storageRoot = parsed.storage_root;
  }
  if (
    typeof parsed.web_port === 'number' &&
    Number.isInteger(parsed.web_port)
  ) {
    config.webPort = parsed.web_port;
  }
  if (typeof parsed.ff_check === 'boolean') {
    config.ffCheck = parsed.ff_check;
  }
  if (typeof parsed.fetch_before_compare === 'boolean') {
    config.fetchBeforeCompare = parsed.fetch_before_compare;
  }
  if (typeof parsed.cursor_hooks_enabled === 'boolean') {
    config.cursorHooksEnabled = parsed.cursor_hooks_enabled;
  }
  if (Array.isArray(parsed.self_emails)) {
    config.selfEmails = parsed.self_emails.filter(
      (value): value is string => typeof value === 'string',
    );
  }
  if (Array.isArray(parsed.self_names)) {
    config.selfNames = parsed.self_names.filter(
      (value): value is string => typeof value === 'string',
    );
  }
  if (Array.isArray(parsed.ignore)) {
    config.ignore = parsed.ignore.filter(
      (value): value is string => typeof value === 'string',
    );
  }

  return config;
}

function readEnvConfig(): UserConfig {
  const config: UserConfig = {};

  config.targetBranch = readStringEnv('AGENT_TRACKER_TARGET_BRANCH');
  config.storageRoot = readStringEnv('AGENT_TRACKER_STORAGE_ROOT');
  config.webPort = readNumberEnv('AGENT_TRACKER_WEB_PORT');
  config.ffCheck = readBooleanEnv('AGENT_TRACKER_FF_CHECK');
  config.fetchBeforeCompare = readBooleanEnv(
    'AGENT_TRACKER_FETCH_BEFORE_COMPARE',
  );
  config.cursorHooksEnabled = readBooleanEnv(
    'AGENT_TRACKER_CURSOR_HOOKS_ENABLED',
  );
  config.selfEmails = readListEnv('AGENT_TRACKER_SELF_EMAILS');
  config.selfNames = readListEnv('AGENT_TRACKER_SELF_NAMES');
  config.ignore = readListEnv('AGENT_TRACKER_IGNORE');

  return config;
}

function applyConfigLayer(
  config: EffectiveConfig,
  sources: SourceMap,
  layer: UserConfig,
  source: string,
): void {
  if (layer.targetBranch) {
    config.targetBranch = layer.targetBranch;
    sources.targetBranch = source;
  }
  if (layer.storageRoot) {
    config.storageRoot = layer.storageRoot;
    sources.storageRoot = source;
  }
  if (typeof layer.webPort === 'number') {
    config.webPort = layer.webPort;
    sources.webPort = source;
  }
  if (typeof layer.ffCheck === 'boolean') {
    config.ffCheck = layer.ffCheck;
    sources.ffCheck = source;
  }
  if (typeof layer.fetchBeforeCompare === 'boolean') {
    config.fetchBeforeCompare = layer.fetchBeforeCompare;
    sources.fetchBeforeCompare = source;
  }
  if (typeof layer.cursorHooksEnabled === 'boolean') {
    config.cursorHooksEnabled = layer.cursorHooksEnabled;
    sources.cursorHooksEnabled = source;
  }
  if (Array.isArray(layer.selfEmails)) {
    config.selfEmails = layer.selfEmails;
    sources.selfEmails = source;
  }
  if (Array.isArray(layer.selfNames)) {
    config.selfNames = layer.selfNames;
    sources.selfNames = source;
  }
  if (Array.isArray(layer.ignore)) {
    config.ignore = layer.ignore;
    sources.ignore = source;
  }
}

function listMissingProjectConfigKeys(config: UserConfig): string[] {
  return PROJECT_CONFIG_FIELD_MAP.filter(
    ({ configKey }) => typeof config[configKey] === 'undefined',
  ).map(({ fileKey }) => fileKey);
}

function readStringEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readNumberEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();

  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }

  return undefined;
}

function readListEnv(name: string): string[] | undefined {
  const value = process.env[name]?.trim();

  if (!value) {
    return undefined;
  }

  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
