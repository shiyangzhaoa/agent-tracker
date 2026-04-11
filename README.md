# agent-tracker

`agent-tracker` 是一个基于 Bun 的命令行项目，用来分析 Git 仓库里的 AI 代码归因情况。

当前仓库处于 Ink 终端交互界面的早期阶段。运行 `agent-tracker` 时，会直接进入交互式终端界面，而不是传统的子命令流程。
默认首屏就是统计视图，当前交互已经收成“左侧固定导航，右侧内容，底部固定操作条”的形态，优先展示当前分支和 commit 范围内的核心数据。

## 当前状态

当前已经具备：

- Bun 项目初始化
- TypeScript 编译配置
- 基于 Ink 的终端界面入口 `src/bin.ts`
- 基于 `ink-select-input` 的选择式操作界面
- 左侧固定为“统计 / 提交 / 设置 / 健康”四个页面
- 默认进入“统计”页
- 右侧只展示当前页面内容
- 底部固定展示当前操作和快捷键
- 来源分支直接读取当前分支，不做配置项
- 已完成的一次性动作会在对应页面中自动降级或消失
- 仓库初始化和 Cursor 集成安装动作
- 健康检查动作
- 分支和提交的基础摘要视图
- 一条最小可用的 Cursor Hook 采集链路，会把原始事件写入 `.git/agent-tracker/raw/*.jsonl`

当前还不包含：

- Git 归因分析
- Web 仪表盘

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

- `↑ / ↓` 在左侧页面之间切换
- `a` 执行当前页面的推荐操作
- `r` 刷新当前统计
- `[` / `]` 在“提交”视图切换 commit
- `Ctrl+C` 退出界面

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
2. 把 Raw Trace 演进成可归因的数据结构
3. 计算 commit 和 branch 维度的 AI 占比
4. 扩展 TUI，并补上本地 dashboard
