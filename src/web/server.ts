import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveStatePaths } from '../lib/config';
import { buildCommitFileAttribution } from '../lib/line-attribution';
import { getAppSnapshot } from '../lib/snapshot';

export async function runDashboardServer(
  cwd: string,
  options?: { open?: boolean; restart?: boolean; _retryAfterRestart?: boolean },
): Promise<void> {
  const assetPath = await ensureDashboardBundle();
  const cssAssetPath = join(dirname(assetPath), 'dashboard.css');
  const assetVersion = String(Date.now());
  const initialSnapshot = await getAppSnapshot(cwd);
  const port = initialSnapshot.webPort ?? 3487;
  let dashboardUrl = `http://127.0.0.1:${port}`;

  let server: ReturnType<typeof Bun.serve>;

  try {
    server = Bun.serve({
      port,
      idleTimeout: 60,
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response(renderDashboardHtml(assetVersion), {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          });
        }

        if (url.pathname === '/assets/dashboard.js') {
          return new Response(Bun.file(assetPath), {
            headers: {
              'content-type': 'text/javascript; charset=utf-8',
              'cache-control': 'no-cache',
            },
          });
        }

        if (url.pathname === '/assets/dashboard.css') {
          return new Response(Bun.file(cssAssetPath), {
            headers: {
              'content-type': 'text/css; charset=utf-8',
              'cache-control': 'no-cache',
            },
          });
        }

        if (url.pathname === '/api/snapshot') {
          const snapshot = await getAppSnapshot(cwd);
          return json(snapshot);
        }

        const commitFileMatch = /^\/api\/commit\/([^/]+)\/file$/.exec(
          url.pathname,
        );
        if (commitFileMatch) {
          const sha = decodeURIComponent(commitFileMatch[1] ?? '');
          const path = url.searchParams.get('path');

          if (!path) {
            return json({ error: 'missing path' }, 400);
          }

          const fileAttribution = await getCommitFileAttribution(
            cwd,
            sha,
            path,
          );
          if (!fileAttribution) {
            return json({ error: 'not found' }, 404);
          }

          return json(fileAttribution);
        }

        return new Response('Not Found', { status: 404 });
      },
    });
  } catch (error) {
    const isAddressInUse =
      error instanceof Error &&
      /EADDRINUSE|port\s+\d+\s+in\s+use/i.test(error.message);
    if (isAddressInUse && options?.restart && !options._retryAfterRestart) {
      const terminated = terminateProcessListeningOnPort(port);
      if (terminated) {
        await runDashboardServer(cwd, {
          ...options,
          _retryAfterRestart: true,
        });
        return;
      }
    }

    if (isAddressInUse && options?.open) {
      const healthy = await isDashboardInstanceHealthy(dashboardUrl);
      if (healthy) {
        console.log(`dashboard 已在运行：${dashboardUrl}`);
        openUrl(dashboardUrl);
        return;
      }

      throw new Error(
        `端口 ${port} 已被占用，但现有 dashboard 资源不完整（样式可能失效）。请先结束占用进程后重试。`,
      );
    }

    throw error;
  }

  dashboardUrl = `http://127.0.0.1:${server.port}`;
  console.log(`dashboard 已启动：${dashboardUrl}`);

  if (options?.open) {
    openUrl(dashboardUrl);
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true);
      resolve();
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export function launchDashboardDetached(
  cwd: string,
  options?: { open?: boolean },
): void {
  const bunBinary = process.argv[0] ?? 'bun';
  const entryFile = Bun.main || process.argv[1];
  const shouldOpen = options?.open ?? true;

  const logPath = join(cwd, '.git', 'agent-tracker', 'dashboard.log');
  const dashboardArgs = shouldOpen
    ? 'dashboard --open --restart'
    : 'dashboard --restart';
  const launchCommand = entryFile
    ? `nohup ${shellQuote(bunBinary)} ${shellQuote(entryFile)} ${dashboardArgs} > ${shellQuote(logPath)} 2>&1 &`
    : `nohup ${shellQuote(process.execPath)} ${dashboardArgs} > ${shellQuote(logPath)} 2>&1 &`;

  const command = [
    `mkdir -p ${shellQuote(dirname(logPath))}`,
    launchCommand,
  ].join(' && ');

  Bun.spawn({
    cmd: ['/bin/sh', '-lc', command],
    cwd,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function getCommitFileAttribution(
  cwd: string,
  sha: string,
  path: string,
) {
  const snapshot = await getAppSnapshot(cwd);
  if (
    !snapshot.available ||
    !snapshot.repoRoot ||
    !snapshot.storageRoot ||
    !snapshot.branchData
  ) {
    return null;
  }

  const commitIndex = snapshot.branchData.commits.findIndex(
    (commit) => commit.sha === sha || commit.shortSha === sha,
  );
  if (commitIndex < 0) {
    return null;
  }

  const commit = snapshot.branchData.commits[commitIndex];
  if (!commit) {
    return null;
  }

  const file = commit.files.find((entry) => entry.path === path);
  if (!file) {
    return null;
  }

  const previousCommittedAt =
    commitIndex > 0
      ? (snapshot.branchData.commits[commitIndex - 1]?.committedAt ??
        snapshot.branchData.baseCommittedAt)
      : snapshot.branchData.baseCommittedAt;

  return buildCommitFileAttribution({
    repoRoot: snapshot.repoRoot,
    statePaths: resolveStatePaths(
      snapshot.repoRoot,
      snapshot.storageRoot,
      snapshot.gitDir,
    ),
    currentBranch: snapshot.sourceBranch ?? 'HEAD',
    commit,
    previousCommittedAt,
    file,
  });
}

async function ensureDashboardBundle(): Promise<string> {
  const packageRoot = dirname(
    dirname(process.argv[1] ?? new URL('../bin.ts', import.meta.url).pathname),
  );
  const sourcePath = join(packageRoot, 'src', 'web', 'client.tsx');
  const cssSourcePath = join(packageRoot, 'src', 'web', 'styles.css');
  const outputPath = join(packageRoot, 'dist', 'web', 'dashboard.js');
  const cssOutputPath = join(packageRoot, 'dist', 'web', 'dashboard.css');

  if (existsSync(sourcePath)) {
    await mkdir(dirname(outputPath), { recursive: true });

    const build = Bun.spawnSync({
      cmd: [
        process.argv[0] ?? 'bun',
        'build',
        sourcePath,
        '--outfile',
        outputPath,
        '--target',
        'browser',
      ],
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (build.exitCode !== 0) {
      throw new Error(
        new TextDecoder().decode(build.stderr) || '构建 dashboard 失败。',
      );
    }

    if (existsSync(cssSourcePath)) {
      const cssBuild = Bun.spawnSync({
        cmd: [
          process.argv[0] ?? 'bun',
          'x',
          '@tailwindcss/cli',
          '-i',
          cssSourcePath,
          '-o',
          cssOutputPath,
          '--minify',
        ],
        cwd: packageRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      if (cssBuild.exitCode !== 0) {
        throw new Error(
          new TextDecoder().decode(cssBuild.stderr) ||
            '构建 dashboard 样式失败。',
        );
      }
    }

    return outputPath;
  }

  if (existsSync(outputPath)) {
    return outputPath;
  }

  throw new Error('dashboard 资源不存在，且当前环境无法从源码构建。');
}

function renderDashboardHtml(assetVersion: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>agent-tracker dashboard</title>
    <link rel="stylesheet" href="/assets/dashboard.css?v=${assetVersion}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/dashboard.js?v=${assetVersion}"></script>
  </body>
</html>`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

export function openUrl(url: string): void {
  const openCommand =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', url]
        : ['xdg-open', url];

  Bun.spawn({
    cmd: openCommand,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function isDashboardInstanceHealthy(baseUrl: string): Promise<boolean> {
  try {
    const [htmlResponse, cssResponse] = await Promise.all([
      fetch(`${baseUrl}/`, { redirect: 'manual' }),
      fetch(`${baseUrl}/assets/dashboard.css`, { redirect: 'manual' }),
    ]);

    if (!htmlResponse.ok || !cssResponse.ok) {
      return false;
    }

    const html = await htmlResponse.text();
    return html.includes('/assets/dashboard.css');
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function terminateProcessListeningOnPort(port: number): boolean {
  const command =
    process.platform === 'win32'
      ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a >nul 2>&1`
      : `lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill`;

  const result = Bun.spawnSync({
    cmd: ['/bin/sh', '-lc', command],
    stdout: 'ignore',
    stderr: 'ignore',
  });

  return result.exitCode === 0;
}
