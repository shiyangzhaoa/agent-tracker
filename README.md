# agent-tracker

`agent-tracker` 是一个基于 Bun 的命令行项目，用来分析 Git 仓库里的 AI 代码归因情况。

当前仓库处于 Ink 终端交互界面的早期阶段。运行 `agent-tracker` 时，会直接进入交互式终端界面，而不是传统的子命令流程。
默认首屏就是统计视图，当前交互已经收成“信息区 / 详情区 / 水平导航 / 快捷键”的上下布局，优先展示当前分支和 commit 范围内的核心数据。

## 当前状态

当前已经具备：

- Bun 项目初始化
- TypeScript 编译配置
- 基于 Ink 的终端界面入口 `src/bin.ts`
- 水平一级导航：`统计 / 提交 / 仪表盘 / 设置 / 健康`
- 默认进入“统计”页
- 终端上下布局，diff 有更大的可视区域
- 来源分支直接读取当前分支，不做配置项
- 已完成的一次性动作会在对应页面中自动降级或消失
- 仓库初始化和 Cursor 集成安装动作
- 健康检查动作
- 分支和提交的行级 AI 统计摘要
- 提交列表、提交详情、文件详情三级下钻
- 浏览器端本地 dashboard，支持概览 / 提交工作台 / 健康页
- 一条最小可用的 Cursor Hook 采集链路，会把原始事件写入 `.git/agent-tracker/raw/*.jsonl`
- `Human` 证据链已支持三类强证据：人工快照、reconcile 快照、改写已知 AI 行

当前还不包含：

- 远程共享或多人协作 dashboard

## 快速开始

安装依赖：

```bash
bun install
```

启动交互界面：

```bash
bun run dev
```

构建后，也可以直接运行发布入口：

```bash
bun ./dist/index.js
```

进入界面后，可以这样操作：

- `← / →` 在统计、提交、仪表盘、设置、健康之间切换
- `↑ / ↓` 在提交、文件或任务列表中移动选择，或在文件 diff 中滚动
- `[` / `]` 在文件详情里切换上一文件 / 下一文件
- `Enter` 打开当前选中的提交、文件或执行当前任务
- `Esc / Backspace` 返回上一层
- `r` 刷新当前统计
- `Ctrl+C` 退出界面

也可以直接启动浏览器端 dashboard：

```bash
bun run dashboard
```

比如在“设置”页里，如果仓库已经完成初始化，初始化动作就不会再反复出现；如果 Cursor 集成已经安装，安装动作也会自动降级。

当前唯一仍然保留给非交互场景使用的直接命令，是内部 Cursor Hook 回调入口：

```bash
bun ./dist/index.js collect cursor hook
```

## 用户手册

可查看这份面向用户的说明：

- [docs/USER_GUIDE.zh-CN.md](/Users/ssss/workspace/github/agent-tracker/docs/USER_GUIDE.zh-CN.md)

## 下一步重点

后续计划重点是：

1. 继续完善 Cursor Hook 安装和 Trace 采集
2. 继续补强 `Human` 证据链，覆盖更细的人工保存/补偿来源
3. 补更完整的 commit / file drill-down
4. 继续完善 dashboard 和数据解释能力
