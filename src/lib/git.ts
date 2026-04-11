import { join } from 'node:path';

export interface RepoContext {
  cwd: string;
  repoRoot: string;
  gitDir: string;
  currentBranch: string | null;
  originUrl: string | null;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

export interface BranchComparison {
  sourceRef: string | null;
  targetRef: string | null;
  ahead: number | null;
  behind: number | null;
  canFastForward: boolean | null;
  message?: string;
}

export interface WorkingTreeSummary {
  isDirty: boolean;
  entryCount: number;
}

export interface WorkingTreeFileEntry {
  path: string;
  absolutePath: string;
  status: string;
}

export interface WorkingTreeStatusEntry {
  path: string;
  status: string;
  previousPath?: string;
}

export interface CommitFileStat {
  path: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'changed';
  previousPath?: string;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  files: CommitFileStat[];
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CommitDiffHunkLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface CommitDiffHunk {
  header: string;
  lines: CommitDiffHunkLine[];
}

export interface CommitFileDiff {
  path: string;
  patch: string;
  hunks: CommitDiffHunk[];
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

const decoder = new TextDecoder();

export function getRepoContext(cwd: string): RepoContext {
  const repoRoot = runGitOrThrow(cwd, ['rev-parse', '--show-toplevel']).stdout;
  const gitDirOutput = runGitOrThrow(cwd, [
    'rev-parse',
    '--absolute-git-dir',
  ]).stdout;
  const currentBranchOutput = runGit(cwd, ['branch', '--show-current']);
  const originUrlOutput = runGit(cwd, ['remote', 'get-url', 'origin']);

  return {
    cwd,
    repoRoot,
    gitDir: gitDirOutput,
    currentBranch:
      currentBranchOutput.exitCode === 0 &&
      currentBranchOutput.stdout.length > 0
        ? currentBranchOutput.stdout
        : null,
    originUrl:
      originUrlOutput.exitCode === 0 && originUrlOutput.stdout.length > 0
        ? originUrlOutput.stdout
        : null,
  };
}

export function compareBranches(
  repoRoot: string,
  sourceBranch: string,
  targetBranch: string,
): BranchComparison {
  const sourceRef = resolveBranchRef(repoRoot, sourceBranch) ?? sourceBranch;
  const targetRef = resolveBranchRef(repoRoot, targetBranch);

  if (!targetRef) {
    return {
      sourceRef: branchExists(repoRoot, sourceRef) ? sourceRef : null,
      targetRef: null,
      ahead: null,
      behind: null,
      canFastForward: null,
      message: `目标分支 "${targetBranch}" 在本地和 origin/${targetBranch} 中都不存在`,
    };
  }

  if (!branchExists(repoRoot, sourceRef)) {
    return {
      sourceRef: null,
      targetRef,
      ahead: null,
      behind: null,
      canFastForward: null,
      message: `来源分支 "${sourceBranch}" 不存在`,
    };
  }

  const countResult = runGit(repoRoot, [
    'rev-list',
    '--left-right',
    '--count',
    `${targetRef}...${sourceRef}`,
  ]);
  let behind: number | null = null;
  let ahead: number | null = null;

  if (countResult.exitCode === 0) {
    const [behindText, aheadText] = countResult.stdout.split(/\s+/);
    behind = Number.parseInt(behindText ?? '', 10);
    ahead = Number.parseInt(aheadText ?? '', 10);
    if (!Number.isFinite(behind)) {
      behind = null;
    }
    if (!Number.isFinite(ahead)) {
      ahead = null;
    }
  }

  const ffResult = runGit(repoRoot, [
    'merge-base',
    '--is-ancestor',
    targetRef,
    sourceRef,
  ]);
  const canFastForward =
    ffResult.exitCode === 0 ? true : ffResult.exitCode === 1 ? false : null;

  return {
    sourceRef,
    targetRef,
    ahead,
    behind,
    canFastForward,
    message: ffResult.exitCode > 1 ? ffResult.stderr : undefined,
  };
}

export function getWorkingTreeSummary(repoRoot: string): WorkingTreeSummary {
  const lines = readStatusLines(repoRoot);

  return {
    isDirty: lines.length > 0,
    entryCount: lines.length,
  };
}

export function listWorkingTreeFiles(repoRoot: string): WorkingTreeFileEntry[] {
  const entries: WorkingTreeFileEntry[] = [];

  for (const line of readStatusLines(repoRoot)) {
    const status = line.slice(0, 2);
    let path = line.slice(3).trim();

    if (!path) {
      continue;
    }

    if (path.includes(' -> ')) {
      const renamed = path.split(' -> ').pop()?.trim();
      if (!renamed) {
        continue;
      }
      path = renamed;
    }

    if (status.includes('D')) {
      continue;
    }

    entries.push({
      path,
      absolutePath: join(repoRoot, path),
      status,
    });
  }

  return dedupeWorkingTreeEntries(entries);
}

export function listWorkingTreeStatusEntries(
  repoRoot: string,
): WorkingTreeStatusEntry[] {
  const entries: WorkingTreeStatusEntry[] = [];

  for (const line of readStatusLines(repoRoot)) {
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();

    if (!rawPath) {
      continue;
    }

    if (rawPath.includes(' -> ')) {
      const [previousPath, nextPath] = rawPath
        .split(' -> ')
        .map((part) => part.trim());
      if (!nextPath) {
        continue;
      }

      entries.push({
        path: nextPath,
        previousPath: previousPath || undefined,
        status,
      });
      continue;
    }

    entries.push({
      path: rawPath,
      status,
    });
  }

  return dedupeWorkingTreeStatusEntries(entries);
}

export function getLocalGitIdentity(repoRoot: string): GitIdentity {
  const nameResult = runGit(repoRoot, ['config', '--get', 'user.name']);
  const emailResult = runGit(repoRoot, ['config', '--get', 'user.email']);

  return {
    name:
      nameResult.exitCode === 0 && nameResult.stdout.length > 0
        ? nameResult.stdout
        : null,
    email:
      emailResult.exitCode === 0 && emailResult.stdout.length > 0
        ? emailResult.stdout
        : null,
  };
}

export function getReferenceCommitTime(
  repoRoot: string,
  ref: string,
): string | null {
  const result = runGit(repoRoot, ['show', '-s', '--format=%cI', ref]);
  return result.exitCode === 0 && result.stdout.length > 0
    ? result.stdout
    : null;
}

export function listBranchCommits(
  repoRoot: string,
  sourceRef: string,
  targetRef: string,
): GitCommitSummary[] {
  const revListResult = runGitOrThrow(repoRoot, [
    'rev-list',
    '--reverse',
    `${targetRef}..${sourceRef}`,
  ]);
  const shas = revListResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return shas.map((sha) => readCommitSummary(repoRoot, sha));
}

export function readCommitFileDiff(
  repoRoot: string,
  sha: string,
  filePath: string,
): CommitFileDiff | null {
  const result = runGitOrThrow(repoRoot, [
    'show',
    '--format=',
    '--unified=3',
    '--no-ext-diff',
    '--no-color',
    sha,
    '--',
    filePath,
  ]);

  return parseCommitFileDiff(filePath, result.stdout);
}

function resolveBranchRef(repoRoot: string, branchName: string): string | null {
  const candidates = [
    `refs/heads/${branchName}`,
    `refs/remotes/origin/${branchName}`,
  ];

  for (const candidate of candidates) {
    if (branchExists(repoRoot, candidate)) {
      return candidate;
    }
  }

  return null;
}

function branchExists(repoRoot: string, ref: string): boolean {
  return (
    runGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref]).exitCode === 0
  );
}

function runGitOrThrow(cwd: string, args: string[]): CommandResult {
  const result = runGit(cwd, args);

  if (result.exitCode !== 0) {
    throw new GitCommandError(
      `git ${args.join(' ')} 执行失败，退出码 ${result.exitCode}`,
      result.stderr,
    );
  }

  return result;
}

function readCommitSummary(repoRoot: string, sha: string): GitCommitSummary {
  const result = runGitOrThrow(repoRoot, [
    'show',
    '--numstat',
    '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s',
    '--no-ext-diff',
    '--no-color',
    sha,
  ]);
  const statusResult = runGitOrThrow(repoRoot, [
    'show',
    '--name-status',
    '--format=',
    '--find-renames',
    '--no-ext-diff',
    '--no-color',
    sha,
  ]);

  const lines = result.stdout.split('\n');
  const header = lines[0] ?? '';
  const [
    fullSha,
    shortSha,
    authorName,
    authorEmail,
    authoredAt,
    committedAt,
    subject,
  ] = header.split('\u001f');

  const statusByPath = parseCommitNameStatus(statusResult.stdout);
  const files = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseNumStatLine(line, statusByPath))
    .filter((entry): entry is CommitFileStat => entry !== null);

  return {
    sha: fullSha ?? sha,
    shortSha: shortSha ?? sha.slice(0, 7),
    subject: subject ?? '(no subject)',
    authorName: authorName ?? 'unknown',
    authorEmail: authorEmail ?? 'unknown',
    authoredAt: authoredAt ?? '',
    committedAt: committedAt ?? '',
    files,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function parseNumStatLine(
  line: string,
  statusByPath: Map<
    string,
    { status: CommitFileStat['status']; previousPath?: string }
  >,
): CommitFileStat | null {
  const firstTab = line.indexOf('\t');
  if (firstTab === -1) {
    return null;
  }

  const secondTab = line.indexOf('\t', firstTab + 1);
  if (secondTab === -1) {
    return null;
  }

  const additionsText = line.slice(0, firstTab);
  const deletionsText = line.slice(firstTab + 1, secondTab);
  const path = line.slice(secondTab + 1).trim();

  if (!path) {
    return null;
  }

  const isBinary = additionsText === '-' || deletionsText === '-';
  const statusEntry = statusByPath.get(path);

  return {
    path,
    additions: isBinary ? 0 : Number.parseInt(additionsText, 10) || 0,
    deletions: isBinary ? 0 : Number.parseInt(deletionsText, 10) || 0,
    isBinary,
    status:
      statusEntry?.status ??
      inferCommitFileStatus(path, additionsText, deletionsText),
    previousPath: statusEntry?.previousPath,
  };
}

function parseCommitNameStatus(
  stdout: string,
): Map<string, { status: CommitFileStat['status']; previousPath?: string }> {
  const result = new Map<
    string,
    { status: CommitFileStat['status']; previousPath?: string }
  >();

  for (const line of stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const parts = line.split('\t');
    const rawStatus = parts[0] ?? '';

    if (rawStatus.startsWith('R')) {
      const previousPath = parts[1]?.trim();
      const path = parts[2]?.trim();
      if (!path) {
        continue;
      }

      result.set(path, {
        status: 'renamed',
        previousPath,
      });
      continue;
    }

    const path = parts[1]?.trim();
    if (!path) {
      continue;
    }

    result.set(path, {
      status: mapCommitNameStatus(rawStatus),
    });
  }

  return result;
}

function mapCommitNameStatus(rawStatus: string): CommitFileStat['status'] {
  if (rawStatus.startsWith('A')) {
    return 'added';
  }

  if (rawStatus.startsWith('D')) {
    return 'deleted';
  }

  if (rawStatus.startsWith('M')) {
    return 'modified';
  }

  return 'changed';
}

function inferCommitFileStatus(
  path: string,
  additionsText: string,
  deletionsText: string,
): CommitFileStat['status'] {
  if (additionsText === '0' && deletionsText !== '0') {
    return 'deleted';
  }

  if (deletionsText === '0' && additionsText !== '0') {
    return 'added';
  }

  return path.length > 0 ? 'modified' : 'changed';
}

function parseCommitFileDiff(
  filePath: string,
  stdout: string,
): CommitFileDiff | null {
  const lines = stdout.split('\n');
  const hunks: CommitDiffHunk[] = [];
  let currentHunk: CommitDiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      currentHunk = {
        header: line,
        lines: [],
      };
      hunks.push(currentHunk);

      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLineNumber = match ? Number.parseInt(match[1] ?? '0', 10) : 0;
      newLineNumber = match ? Number.parseInt(match[2] ?? '0', 10) : 0;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith('\\ No newline')) {
      continue;
    }

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        kind: 'add',
        text: line.slice(1),
        oldLineNumber: null,
        newLineNumber,
      });
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith('-')) {
      currentHunk.lines.push({
        kind: 'remove',
        text: line.slice(1),
        oldLineNumber,
        newLineNumber: null,
      });
      oldLineNumber += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        kind: 'context',
        text: line.slice(1),
        oldLineNumber,
        newLineNumber,
      });
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  if (hunks.length === 0) {
    return null;
  }

  return {
    path: filePath,
    patch: stdout,
    hunks,
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function readStatusLines(repoRoot: string): string[] {
  const subprocess = Bun.spawnSync({
    cmd: ['git', 'status', '--short', '-z'],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (subprocess.exitCode !== 0) {
    throw new GitCommandError(
      'git status --short -z 执行失败',
      decoder.decode(subprocess.stderr).trim(),
    );
  }

  return decoder
    .decode(subprocess.stdout)
    .split('\0')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function dedupeWorkingTreeEntries(
  entries: WorkingTreeFileEntry[],
): WorkingTreeFileEntry[] {
  const byPath = new Map<string, WorkingTreeFileEntry>();

  for (const entry of entries) {
    byPath.set(entry.path, entry);
  }

  return [...byPath.values()];
}

function dedupeWorkingTreeStatusEntries(
  entries: WorkingTreeStatusEntry[],
): WorkingTreeStatusEntry[] {
  const byPath = new Map<string, WorkingTreeStatusEntry>();

  for (const entry of entries) {
    byPath.set(entry.path, entry);
  }

  return [...byPath.values()];
}

function runGit(cwd: string, args: string[]): CommandResult {
  const subprocess = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    stdout: decoder.decode(subprocess.stdout).trim(),
    stderr: decoder.decode(subprocess.stderr).trim(),
    exitCode: subprocess.exitCode,
  };
}
