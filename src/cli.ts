import { runCollectCursorInstall } from './commands/collect-cursor-install';
import { runCollectCursorHook } from './commands/collect-cursor-hook';
import { renderApp } from './tui/app';
import { runDashboardServer } from './web/server';

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    await renderApp(process.cwd());
    return;
  }

  if (argv[0] === 'collect' && argv[1] === 'cursor' && argv[2] === 'hook') {
    process.exitCode = await runCollectCursorHook(process.cwd(), argv.slice(3));
    return;
  }

  if (argv[0] === 'collect' && argv[1] === 'cursor' && argv[2] === 'install') {
    process.exitCode = await runCollectCursorInstall(process.cwd());
    return;
  }

  if (argv[0] === 'collect' && argv[1] === 'cursor' && argv[2] === 'repair') {
    process.exitCode = await runCollectCursorInstall(process.cwd());
    return;
  }

  if (argv[0] === 'dashboard') {
    await runDashboardServer(process.cwd(), {
      open: argv.includes('--open'),
      restart: argv.includes('--restart'),
    });
    return;
  }

  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log('agent-tracker');
    console.log('');
    console.log('不带参数运行时，会直接打开引导式 Ink 界面。');
    console.log('界面采用上下布局：信息、详情、导航、快捷键。');
    console.log('');
    console.log('常用按键：');
    console.log(
      '  ← / →              在统计、提交、仪表盘、设置、健康之间切换',
    );
    console.log('  ↑ / ↓              在列表里选择，或在文件 diff 中滚动');
    console.log('  [ / ]              在文件详情里切换上一文件 / 下一文件');
    console.log('  Enter              打开当前选中的提交、文件或执行当前任务');
    console.log('  Esc / Backspace    返回上一层');
    console.log('  r                  刷新当前统计');
    console.log('  q                  退出界面');
    console.log('');
    console.log('补充命令：');
    console.log('  dashboard               启动本地浏览器仪表盘');
    console.log('  dashboard --open        启动后自动打开浏览器');
    console.log('  dashboard --restart     如端口被占用，自动终止旧进程并重启');
    console.log('');
    console.log('内部命令：');
    console.log('  collect cursor install  安装或修复 Cursor Hook 集成');
    console.log('  collect cursor repair   安装或修复 Cursor Hook 集成');
    console.log('  collect cursor hook     Cursor Hook 的内部回调入口');
    return;
  }

  if (argv[0] === '--version') {
    const pkg = (await Bun.file(
      new URL('../package.json', import.meta.url),
    ).json()) as { version?: string };
    console.log(pkg.version ?? 'unknown');
    return;
  }

  console.error('agent-tracker 默认会在不带参数时启动引导式界面。');
  console.error(
    '直接运行 agent-tracker，使用 ← / → 切换页面，Enter 打开详情。',
  );
  process.exitCode = 1;
}
