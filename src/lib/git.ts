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

export interface CommitFileStat {
  path: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
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

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

const decoder = new TextDecoder();

export function getRepoContext(cwd: string): RepoContext {
  const repoRoot = runGitOrThrow(cwd, ["rev-parse", "--show-toplevel"]).stdout;
  const gitDirOutput = runGitOrThrow(cwd, ["rev-parse", "--absolute-git-dir"]).stdout;
  const currentBranchOutput = runGit(cwd, ["branch", "--show-current"]);
  const originUrlOutput = runGit(cwd, ["remote", "get-url", "origin"]);

  return {
    cwd,
    repoRoot,
    gitDir: gitDirOutput,
    currentBranch: currentBranchOutput.exitCode === 0 && currentBranchOutput.stdout.length > 0
      ? currentBranchOutput.stdout
      : null,
    originUrl: originUrlOutput.exitCode === 0 && originUrlOutput.stdout.length > 0
      ? originUrlOutput.stdout
      : null,
  };
}

export function compareBranches(repoRoot: string, sourceBranch: string, targetBranch: string): BranchComparison {
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

  const countResult = runGit(repoRoot, ["rev-list", "--left-right", "--count", `${targetRef}...${sourceRef}`]);
  let behind: number | null = null;
  let ahead: number | null = null;

  if (countResult.exitCode === 0) {
    const [behindText, aheadText] = countResult.stdout.split(/\s+/);
    behind = Number.parseInt(behindText ?? "", 10);
    ahead = Number.parseInt(aheadText ?? "", 10);
    if (!Number.isFinite(behind)) {
      behind = null;
    }
    if (!Number.isFinite(ahead)) {
      ahead = null;
    }
  }

  const ffResult = runGit(repoRoot, ["merge-base", "--is-ancestor", targetRef, sourceRef]);
  const canFastForward = ffResult.exitCode === 0 ? true : ffResult.exitCode === 1 ? false : null;

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
  const result = runGitOrThrow(repoRoot, ["status", "--short"]);
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return {
    isDirty: lines.length > 0,
    entryCount: lines.length,
  };
}

export function getLocalGitIdentity(repoRoot: string): GitIdentity {
  const nameResult = runGit(repoRoot, ["config", "--get", "user.name"]);
  const emailResult = runGit(repoRoot, ["config", "--get", "user.email"]);

  return {
    name: nameResult.exitCode === 0 && nameResult.stdout.length > 0 ? nameResult.stdout : null,
    email: emailResult.exitCode === 0 && emailResult.stdout.length > 0 ? emailResult.stdout : null,
  };
}

export function getReferenceCommitTime(repoRoot: string, ref: string): string | null {
  const result = runGit(repoRoot, ["show", "-s", "--format=%cI", ref]);
  return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
}

export function listBranchCommits(repoRoot: string, sourceRef: string, targetRef: string): GitCommitSummary[] {
  const revListResult = runGitOrThrow(repoRoot, ["rev-list", "--reverse", `${targetRef}..${sourceRef}`]);
  const shas = revListResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return shas.map((sha) => readCommitSummary(repoRoot, sha));
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
  return runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]).exitCode === 0;
}

function runGitOrThrow(cwd: string, args: string[]): CommandResult {
  const result = runGit(cwd, args);

  if (result.exitCode !== 0) {
    throw new GitCommandError(
      `git ${args.join(" ")} 执行失败，退出码 ${result.exitCode}`,
      result.stderr,
    );
  }

  return result;
}

function readCommitSummary(repoRoot: string, sha: string): GitCommitSummary {
  const result = runGitOrThrow(repoRoot, [
    "show",
    "--numstat",
    "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s",
    "--no-renames",
    "--no-ext-diff",
    "--no-color",
    sha,
  ]);

  const lines = result.stdout.split("\n");
  const header = lines[0] ?? "";
  const [
    fullSha,
    shortSha,
    authorName,
    authorEmail,
    authoredAt,
    committedAt,
    subject,
  ] = header.split("\u001f");

  const files = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseNumStatLine)
    .filter((entry): entry is CommitFileStat => entry !== null);

  return {
    sha: fullSha ?? sha,
    shortSha: shortSha ?? sha.slice(0, 7),
    subject: subject ?? "(no subject)",
    authorName: authorName ?? "unknown",
    authorEmail: authorEmail ?? "unknown",
    authoredAt: authoredAt ?? "",
    committedAt: committedAt ?? "",
    files,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function parseNumStatLine(line: string): CommitFileStat | null {
  const firstTab = line.indexOf("\t");
  if (firstTab === -1) {
    return null;
  }

  const secondTab = line.indexOf("\t", firstTab + 1);
  if (secondTab === -1) {
    return null;
  }

  const additionsText = line.slice(0, firstTab);
  const deletionsText = line.slice(firstTab + 1, secondTab);
  const path = line.slice(secondTab + 1).trim();

  if (!path) {
    return null;
  }

  const isBinary = additionsText === "-" || deletionsText === "-";

  return {
    path,
    additions: isBinary ? 0 : Number.parseInt(additionsText, 10) || 0,
    deletions: isBinary ? 0 : Number.parseInt(deletionsText, 10) || 0,
    isBinary,
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGit(cwd: string, args: string[]): CommandResult {
  const subprocess = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: decoder.decode(subprocess.stdout).trim(),
    stderr: decoder.decode(subprocess.stderr).trim(),
    exitCode: subprocess.exitCode,
  };
}
