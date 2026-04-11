import { runCollectCursorHook } from "./commands/collect-cursor-hook";
import { renderApp } from "./tui/app";

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    await renderApp(process.cwd());
    return;
  }

  if (argv[0] === "collect" && argv[1] === "cursor" && argv[2] === "hook") {
    process.exitCode = await runCollectCursorHook(process.cwd());
    return;
  }

  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log("agent-tracker");
    console.log("");
    console.log("不带参数运行时，会直接打开引导式 Ink 界面。");
    console.log("左侧是固定导航，右侧显示当前内容，底部固定显示操作条。");
    console.log("");
    console.log("常用按键：");
    console.log("  ↑ / ↓              在左侧页面之间切换");
    console.log("  ← / →              在底部操作之间切换");
    console.log("  Enter / a          执行当前操作");
    console.log("  r                  刷新当前统计");
    console.log("  [ / ]              在提交视图切换提交");
    console.log("  q                  退出界面");
    console.log("");
    console.log("内部命令：");
    console.log("  collect cursor hook    Cursor Hook 的内部回调入口");
    return;
  }

  if (argv[0] === "--version") {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version?: string };
    console.log(pkg.version ?? "unknown");
    return;
  }

  console.error("agent-tracker 默认会在不带参数时启动引导式界面。");
  console.error("直接运行 agent-tracker，使用 ↑ / ↓ 切换页面，按 a 执行当前页面操作。");
  process.exitCode = 1;
}
