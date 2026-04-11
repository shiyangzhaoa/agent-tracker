import React, { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createRoot } from "react-dom/client";
import { toPng } from "html-to-image";

import { Activity, ArrowLeft, ChevronDown, ChevronRight, Download, FileCode, Folder, GitCommit, Info, LayoutGrid, PanelLeftClose, PanelLeftOpen, RefreshCw, SlidersHorizontal } from "lucide-react";

import { Badge as UIBadge } from "./components/ui/badge";
import {
  Card as UICard,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Progress } from "./components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { CommitFileAccordionItem } from "./components/commit-file-accordion-item";
import type {
  AppSnapshot,
  AttributionEvidenceSummary,
  BranchDataSummary,
  CommitDataSummary,
  SnapshotTone,
} from "./types";

type AuthorFilter = "all" | "self" | "team";
type CoverageFilter = "all" | "with-ai" | "with-human" | "review";

type Route =
  | { kind: "overview" }
  | { kind: "commits"; sha?: string }
  | { kind: "file"; sha: string; path: string }
  | { kind: "health" }
  | { kind: "settings" };

const PAGE_TRANSITION = {
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1],
} as const;

function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-btn${active ? " active" : ""}`} onClick={onClick} aria-label={label}>
      <Icon size={18} strokeWidth={1.8} />
      <span className="nav-tooltip">{label}</span>
    </button>
  );
}

function NavInfoButton({ snapshot }: { snapshot: AppSnapshot | null }) {
  return (
    <div className="nav-info-wrap">
      <button className="nav-btn" aria-label="仓库信息">
        <Info size={18} strokeWidth={1.8} />
        <span className="nav-tooltip">仓库信息</span>
      </button>
      <div className="nav-info-popover">
        <div className="nav-info-head">
          <strong>{snapshot?.repoRoot ? lastSegment(snapshot.repoRoot) : "agent-tracker"}</strong>
          <ToneBadge tone={snapshot?.tone ?? "warn"}>{toneLabel(snapshot?.tone ?? "warn")}</ToneBadge>
        </div>
        <div className="nav-info-branch">
          {snapshot?.sourceBranch && snapshot?.targetBranch
            ? `${snapshot.sourceBranch} → ${snapshot.targetBranch}`
            : snapshot?.currentBranch ?? "未识别分支"}
        </div>
        <div className="nav-info-grid">
          <InfoMini label="原始采集" value={String(snapshot?.rawTraceEvents ?? 0)} />
          <InfoMini label="数据标准化" value={String(snapshot?.normalizedTraceEvents ?? 0)} />
          <InfoMini label="人工快照" value={String(snapshot?.normalizedHumanSnapshotEvents ?? 0)} />
          <InfoMini label="系统异常" value={String(snapshot?.issues.length ?? 0)} />
        </div>
      </div>
    </div>
  );
}

function DashboardApp() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useHashRoute();
  const [query, setQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>("all");
  const [overviewAuthorFilter, setOverviewAuthorFilter] = useState<AuthorFilter>("all");
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("all");
  const deferredQuery = useDeferredValue(query);

  const refreshSnapshot = async (retries = 0) => {
    setLoading(true);
    try {
      const response = await fetch("/api/snapshot");
      const payload = await response.json() as AppSnapshot;
      setSnapshot(payload);
      setLoading(false);
    } catch {
      if (retries < 10) {
        await new Promise((r) => setTimeout(r, 500 + retries * 300));
        return refreshSnapshot(retries + 1);
      }
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshSnapshot();
  }, []);

  const commitTimeline = useMemo(
    () => [...(snapshot?.branchData?.commits ?? [])].reverse(),
    [snapshot?.branchData?.commits],
  );
  const filteredCommits = useMemo(
    () => filterCommits(commitTimeline, deferredQuery, authorFilter, coverageFilter),
    [authorFilter, commitTimeline, coverageFilter, deferredQuery],
  );
  const selectedCommit = useMemo(() => {
    if (route.kind !== "commits" && route.kind !== "file") {
      return filteredCommits[0] ?? null;
    }

    return filteredCommits.find((commit) => commit.sha === route.sha)
      ?? commitTimeline.find((commit) => commit.sha === route.sha)
      ?? filteredCommits[0]
      ?? null;
  }, [commitTimeline, filteredCommits, route]);

  const overviewBranch = useMemo(
    () => aggregateOverviewBranch(snapshot?.branchData ?? null, overviewAuthorFilter),
    [overviewAuthorFilter, snapshot?.branchData],
  );

  const activeTab = route.kind === "health"
    ? "health"
    : route.kind === "settings"
      ? "settings"
      : route.kind === "overview"
        ? "overview"
        : "commits";
  const suppressInitialContent = loading && snapshot === null;

  return (
    <div className="app-shell">
      <div className="app-body">
        <header className="app-topbar">
          <div className="topbar-main">
            <strong className="topbar-repo">{snapshot?.repoRoot ? lastSegment(snapshot.repoRoot) : "—"}</strong>
            {snapshot?.sourceBranch && snapshot?.targetBranch
              ? <span className="topbar-branch">{snapshot.sourceBranch} → {snapshot.targetBranch}</span>
              : null}
          </div>
          <div className="topbar-actions">
            <ToneBadge tone={snapshot?.tone ?? "warn"}>{toneLabel(snapshot?.tone ?? "warn")}</ToneBadge>
            <button className={`topbar-refresh${loading ? " spinning" : ""}`} onClick={() => void refreshSnapshot()} aria-label="刷新">
              <RefreshCw size={13} strokeWidth={2} />
            </button>
          </div>
        </header>
        <div className="app-content">
          {suppressInitialContent ? (
            <div className="page-idle-fill" />
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {activeTab === "overview" ? (
                <motion.div
                  key="tab-overview"
                  className="page-motion-shell overview-page-shell"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={PAGE_TRANSITION}
                >
                  <OverviewTab
                    snapshot={snapshot}
                    branch={overviewBranch}
                    authorFilter={overviewAuthorFilter}
                    onAuthorFilterChange={setOverviewAuthorFilter}
                  />
                </motion.div>
              ) : activeTab === "commits" ? (
                <motion.div
                  key="tab-commits"
                  className="page-motion-shell commits-page-shell"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={PAGE_TRANSITION}
                >
                  <CommitsTab
                    snapshot={snapshot}
                    commits={filteredCommits}
                    selectedCommit={selectedCommit}
                    query={query}
                    authorFilter={authorFilter}
                    coverageFilter={coverageFilter}
                    onQueryChange={setQuery}
                    onAuthorFilterChange={setAuthorFilter}
                    onCoverageFilterChange={setCoverageFilter}
                    onSelectCommit={(sha) => setRoute({ kind: "commits", sha })}
                  />
                </motion.div>
              ) : activeTab === "settings" ? (
                <motion.div
                  key="tab-settings"
                  className="page-motion-shell settings-page-shell"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={PAGE_TRANSITION}
                >
                  <SettingsTab snapshot={snapshot} />
                </motion.div>
              ) : (
                <motion.div
                  key="tab-health"
                  className="page-motion-shell health-page-shell"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={PAGE_TRANSITION}
                >
                  <HealthTab snapshot={snapshot} />
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>

      <nav className="app-nav">
        <NavButton
          icon={LayoutGrid}
          label="概览"
          active={activeTab === "overview"}
          onClick={() => setRoute({ kind: "overview" })}
        />
        <NavButton
          icon={GitCommit}
          label="提交"
          active={activeTab === "commits"}
          onClick={() => setRoute({ kind: "commits" })}
        />
        <NavButton
          icon={Activity}
          label="健康"
          active={activeTab === "health"}
          onClick={() => setRoute({ kind: "health" })}
        />
        <NavButton
          icon={SlidersHorizontal}
          label="设置"
          active={activeTab === "settings"}
          onClick={() => setRoute({ kind: "settings" })}
        />
        <div className="nav-spacer" />
        <NavInfoButton snapshot={snapshot} />
      </nav>
    </div>
  );
}

function OverviewTab({
  snapshot,
  branch,
  authorFilter,
  onAuthorFilterChange,
}: {
  snapshot: AppSnapshot | null;
  branch: BranchDataSummary | null;
  authorFilter: AuthorFilter;
  onAuthorFilterChange: (value: AuthorFilter) => void;
}) {
  if (!snapshot?.available || !branch) {
    return (
      <div className="ov-empty-wrap">
        <OverviewUnavailableState snapshot={snapshot} />
      </div>
    );
  }
  const aiPct = branch.aiLineCoveragePercent ?? 0;
  const humanPct = branch.humanLineCoveragePercent ?? 0;
  const unknownPct = branch.unknownLineCoveragePercent ?? 0;
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    const root = document.querySelector(".ov-root") as HTMLElement | null;
    if (!root || exporting) {
      return;
    }

    setExporting(true);
    const scrollParent = root.closest(".overview-page-shell") as HTMLElement | null;
    const savedOverflow = scrollParent?.style.overflow ?? "";
    const savedScrollTop = scrollParent?.scrollTop ?? 0;
    if (scrollParent) {
      scrollParent.style.overflow = "hidden";
    }

    root.classList.add("ov-export-mode");
    try {
      await document.fonts?.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const dataUrl = await toPng(root, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#1f1f1f",
        canvasWidth: 1280,
      });

      const link = document.createElement("a");
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      link.download = `agent-tracker-overview-${branch.sourceBranch}-${timestamp}.png`;
      link.href = dataUrl;
      link.click();
    } finally {
      root.classList.remove("ov-export-mode");
      if (scrollParent) {
        scrollParent.style.overflow = savedOverflow;
        scrollParent.scrollTop = savedScrollTop;
      }
      setExporting(false);
    }
  };

  return (
    <main className="ov-root">
      <section className="ov-hero">
        <div className="ov-hero-meta">
          <div className="ov-hero-meta-main">
            <span className="ov-branch-tag">{branch.sourceBranch} → {branch.targetBranch}</span>
            <SegmentedTabs
              items={[
                { id: "all", label: "全部" },
                { id: "self", label: "本人" },
                { id: "team", label: "团队" },
              ]}
              activeId={authorFilter}
              onChange={(value) => onAuthorFilterChange(value as AuthorFilter)}
            />
          </div>
          <div className="ov-hero-actions">
            <span className="ov-coverage-tag">文件覆盖 {formatPercent(branch.observedFileCoveragePercent)}</span>
            <button
              className={`ov-export-btn${exporting ? " exporting" : ""}`}
              onClick={() => void handleExport()}
              disabled={exporting}
              aria-label="导出首页图片"
            >
              <Download size={14} strokeWidth={2} />
              <span>{exporting ? "导出中" : "导出图片"}</span>
            </button>
          </div>
        </div>

        <div className="ov-attr-main">
          <div className="ov-big-pct">
            <span className="ov-big-num">{formatPercent(aiPct)}</span>
            <span className="ov-big-label">AI 代码</span>
          </div>

          <div className="ov-attr-panel">
            <div className="ov-stacked-bar">
              <div className="ov-seg ov-seg-ai" style={{ width: `${aiPct}%` }} />
              <div className="ov-seg ov-seg-human" style={{ width: `${humanPct}%` }} />
              <div className="ov-seg ov-seg-unknown" style={{ width: `${unknownPct}%` }} />
            </div>

            <div className="ov-legend">
              <div className="ov-leg-row">
                <span className="ov-leg-dot ai" />
                <span>AI 生成</span>
                <strong>{branch.aiLines.toLocaleString()} 行</strong>
                <span className="ov-leg-pct">{formatPercent(aiPct)}</span>
              </div>
              <div className="ov-leg-row">
                <span className="ov-leg-dot human" />
                <span>人工编写</span>
                <strong>{branch.humanLines.toLocaleString()} 行</strong>
                <span className="ov-leg-pct">{formatPercent(humanPct)}</span>
              </div>
              <div className="ov-leg-row">
                <span className="ov-leg-dot unknown" />
                <span>未识别</span>
                <strong>{branch.unknownLines.toLocaleString()} 行</strong>
                <span className="ov-leg-pct">{formatPercent(unknownPct)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="ov-kpi-strip">
        <div className="ov-kpi">
          <span className="ov-kpi-label">提交总数</span>
          <strong className="ov-kpi-value">{branch.commitCount}</strong>
          <small className="ov-kpi-sub">本人 {branch.selfCommitCount} · 团队 {branch.teammateCommitCount}</small>
        </div>
        <div className="ov-kpi">
          <span className="ov-kpi-label">新增 / 删除</span>
          <strong className="ov-kpi-value">
            <span className="ov-adds">+{branch.additions.toLocaleString()}</span>
            <span className="ov-dels"> / -{branch.deletions.toLocaleString()}</span>
          </strong>
          <small className="ov-kpi-sub">变更 {branch.filesChanged} 文件 · 忽略 {branch.ignoredFiles}</small>
        </div>
        <div className="ov-kpi">
          <span className="ov-kpi-label">采集会话</span>
          <strong className="ov-kpi-value">{branch.sessionIds.length > 0 ? branch.sessionIds.length : (branch.observedCursorEventCount > 0 ? "—" : "0")}</strong>
          <small className="ov-kpi-sub">
            {branch.observedCursorEventCount.toLocaleString()} 个采集事件
            {branch.sessionIds.length === 0 && branch.observedCursorEventCount > 0 ? " · 无会话 ID" : ""}
          </small>
        </div>
        <div className="ov-kpi">
          <span className="ov-kpi-label">文件覆盖率</span>
          <strong className="ov-kpi-value">{formatPercent(branch.observedFileCoveragePercent)}</strong>
          <small className="ov-kpi-sub">{branch.observedAiFiles} / {branch.filesChanged} 非忽略文件</small>
        </div>
      </section>

      {branch.models.length > 0 ? (
        <section className="ov-models-row">
          <span className="ov-models-label">模型</span>
          {branch.models.map((m) => (
            <span key={m} className="ov-model-chip">{m}</span>
          ))}
        </section>
      ) : null}
    </main>
  );
}

function OverviewUnavailableState({ snapshot }: { snapshot: AppSnapshot | null }) {
  const rawEvents = snapshot?.rawTraceEvents ?? 0;
  const normalizedEvents = snapshot?.normalizedTraceEvents ?? 0;

  return (
    <section className="ov-onboard">
      <div className="ov-onboard-hero">
        <div className="ov-onboard-icon" aria-hidden="true">
          <LayoutGrid size={20} strokeWidth={1.8} />
        </div>
        <div className="ov-onboard-copy">
          <span className="ov-onboard-kicker">
            {snapshot?.repoRoot ? lastSegment(snapshot.repoRoot) : "agent-tracker"}
          </span>
          <h2>当前还没有可展示的统计</h2>
          <p>先完成仓库接入并产生采集数据，概览页会自动显示提交归因、覆盖率和模型分布。</p>
        </div>
      </div>

      <div className="ov-onboard-status-grid">
        <SetupStatusCard
          label="项目配置"
          value={snapshot?.projectConfigExists ? "已就绪" : "待初始化"}
          hint={snapshot?.targetBranch ? `目标分支 ${snapshot.targetBranch}` : "先初始化仓库配置"}
          tone={snapshot?.projectConfigExists ? "ok" : "warn"}
        />
        <SetupStatusCard
          label="Cursor 集成"
          value={snapshot?.cursorInstalled ? "已安装" : "未安装"}
          hint={snapshot?.cursorInstalled ? "可采集编辑快照" : "需要安装或修复 Hook"}
          tone={snapshot?.cursorInstalled ? "ok" : "warn"}
        />
        <SetupStatusCard
          label="采集数据"
          value={rawEvents > 0 ? rawEvents.toLocaleString() : "暂无"}
          hint={normalizedEvents > 0 ? `已标准化 ${normalizedEvents}` : "执行一次接入后刷新"}
          tone={rawEvents > 0 ? "ok" : "muted"}
        />
      </div>

      <div className="ov-onboard-guide">
        <div className="ov-onboard-guide-head">
          <strong>建议下一步</strong>
          <span>完成下面几步后，首页会自动切换为正式统计视图。</span>
        </div>
        <ol className="ov-onboard-steps">
          <li>在 TUI 的“设置”页完成仓库初始化。</li>
          <li>安装或修复 Cursor 集成，确保 Hook 已启用。</li>
          <li>产生一次真实编辑后刷新页面，等待采集数据入库。</li>
        </ol>
      </div>

      {snapshot?.issues.length ? (
        <div className="ov-onboard-issues">
          <strong>当前阻塞</strong>
          <ul>
            {snapshot.issues.slice(0, 3).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function SetupStatusCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "ok" | "warn" | "muted";
}) {
  return (
    <div className={`ov-onboard-status-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function CommitsTab({
  snapshot,
  commits,
  selectedCommit,
  query,
  authorFilter,
  coverageFilter,
  onQueryChange,
  onAuthorFilterChange,
  onCoverageFilterChange,
  onSelectCommit,
}: {
  snapshot: AppSnapshot | null;
  commits: CommitDataSummary[];
  selectedCommit: CommitDataSummary | null;
  query: string;
  authorFilter: AuthorFilter;
  coverageFilter: CoverageFilter;
  onQueryChange: (value: string) => void;
  onAuthorFilterChange: (value: AuthorFilter) => void;
  onCoverageFilterChange: (value: CoverageFilter) => void;
  onSelectCommit: (sha: string) => void;
}) {
  const [paneCollapsed, setPaneCollapsed] = useState(false);
  const [sidebarState, setSidebarState] = useState<"list" | "tree">("list");

  // Reset to list if selectedCommit becomes null
  useEffect(() => {
    if (!selectedCommit) setSidebarState("list");
  }, [selectedCommit]);

  const handleSelectCommit = (sha: string) => {
    onSelectCommit(sha);
    setSidebarState("tree");
  };

  const scrollToDiff = (path: string) => {
    const id = `file-diff-${path}`;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div
      className={`commits-shell${paneCollapsed ? " rail-collapsed" : ""}`}
      style={{ "--commit-rail-width": paneCollapsed ? "40px" : "280px" } as React.CSSProperties}
    >
      <aside className={`commit-pane${paneCollapsed ? " collapsed" : ""}`}>
        <div className="commit-pane-header">
          {!paneCollapsed && (
            <span className="commit-count-label">
              {sidebarState === "list" ? `${commits.length} 提交` : "文件树"}
            </span>
          )}
          <button
            className="pane-toggle-btn"
            aria-label={paneCollapsed ? "展开" : "收起"}
            onClick={() => setPaneCollapsed((c) => !c)}
          >
            {paneCollapsed
              ? <PanelLeftOpen size={14} strokeWidth={2} />
              : <PanelLeftClose size={14} strokeWidth={2} />}
          </button>
        </div>

        {!paneCollapsed && sidebarState === "tree" && selectedCommit && (
          <div className="commit-pane-back" onClick={() => setSidebarState("list")}>
            <ArrowLeft size={14} strokeWidth={2.5} />
            <span>返回提交列表</span>
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          {!paneCollapsed ? (
            sidebarState === "list" ? (
              <motion.div
                key="commit-rail-list"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={PAGE_TRANSITION}
                className="commit-rail-content"
              >
                <div className="commit-search">
                  <Input
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder="搜索提交、作者"
                  />
                  <div className="commit-filter-row">
                    <SegmentedTabs
                      items={[
                        { id: "all", label: "全部" },
                        { id: "self", label: "本人" },
                        { id: "team", label: "团队" },
                      ]}
                      activeId={authorFilter}
                      onChange={(value) => onAuthorFilterChange(value as AuthorFilter)}
                    />
                    <SegmentedTabs
                      items={[
                        { id: "all", label: "全部" },
                        { id: "with-ai", label: "AI" },
                        { id: "with-human", label: "人工" },
                        { id: "review", label: "待确认" },
                      ]}
                      activeId={coverageFilter}
                      onChange={(value) => onCoverageFilterChange(value as CoverageFilter)}
                    />
                  </div>
                </div>

                {commits.length === 0 ? (
                  <EmptyState title="没有匹配的提交" description="调整过滤条件后再试。" compact />
                ) : (
                  <div className="commit-list-scroll">
                    {commits.map((commit) => (
                      <button
                        key={commit.sha}
                        className={`commit-item${commit.sha === selectedCommit?.sha ? " active" : ""}`}
                        onClick={() => handleSelectCommit(commit.sha)}
                      >
                        <div className="commit-item-subject">
                          <span className="commit-item-msg">{commit.subject}</span>
                          <span className="commit-item-sha">{commit.shortSha}</span>
                        </div>
                        <div className="commit-item-meta">
                          <span>{commit.authorName}</span>
                          <span>{formatRelative(commit.committedAt)}</span>
                        </div>
                        <div className="mini-bars">
                          <span className="mini-bar ai" style={{ width: `${commit.aiLineCoveragePercent ?? 0}%` }} />
                          <span className="mini-bar human" style={{ width: `${commit.humanLineCoveragePercent ?? 0}%` }} />
                          <span className="mini-bar unknown" style={{ width: `${commit.unknownLineCoveragePercent ?? 0}%` }} />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="commit-rail-tree"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={PAGE_TRANSITION}
                className="commit-rail-content"
              >
                {selectedCommit && (
                  <div className="commit-list-scroll">
                    <FileTree files={selectedCommit.files} onSelectFile={scrollToDiff} />
                  </div>
                )}
              </motion.div>
            )
          ) : null}
        </AnimatePresence>
      </aside>

      <div className="diff-pane">
        <CommitDetailPanel
          snapshot={snapshot}
          commit={selectedCommit}
        />
      </div>
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: Record<string, TreeNode>;
  file?: any;
}

function FileTree({ files, onSelectFile }: { files: any[]; onSelectFile: (path: string) => void }) {
  const root = useMemo(() => {
    const tree: TreeNode = { name: "root", path: "", children: {} };
    for (const f of files) {
      const parts = f.path.split("/");
      let current = tree;
      let currentPath = "";
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!current.children[part]) {
          current.children[part] = { name: part, path: currentPath, children: {} };
        }
        current = current.children[part];
        if (i === parts.length - 1) {
          current.file = f;
        }
      }
    }
    return tree;
  }, [files]);

  return (
    <div className="file-tree">
      {Object.values(root.children).map((node) => (
        <FileTreeNode key={node.path} node={node} onSelectFile={onSelectFile} depth={0} />
      ))}
    </div>
  );
}

function FileTreeNode({ node, onSelectFile, depth }: { node: TreeNode; onSelectFile: (path: string) => void; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const isFolder = Object.keys(node.children).length > 0;

  if (isFolder) {
    return (
      <div className="tree-folder">
        <div className="tree-node" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown size={14} className="tree-node-icon" /> : <ChevronRight size={14} className="tree-node-icon" />}
          <Folder size={14} className="tree-node-icon" />
          <span>{node.name}</span>
        </div>
        {expanded && (
          <div className="tree-folder-content">
            {Object.values(node.children).map((child) => (
              <FileTreeNode key={child.path} node={child} onSelectFile={onSelectFile} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tree-node" onClick={() => onSelectFile(node.path)}>
      <FileCode size={14} className="tree-node-icon" />
      <span>{node.name}</span>
      <div className="tree-file-meta">
        <span className="add">+{node.file.additions}</span>
        <span className="del">-{node.file.deletions}</span>
      </div>
    </div>
  );
}

function CommitDetailPanel({
  snapshot,
  commit,
}: {
  snapshot: AppSnapshot | null;
  commit: CommitDataSummary | null;
}) {
  const [fileQuery, setFileQuery] = useState("");
  const deferredFileQuery = useDeferredValue(fileQuery);

  const visibleFiles = useMemo(() => {
    if (!commit) {
      return [];
    }

    const normalizedQuery = deferredFileQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return commit.files;
    }

    return commit.files.filter((file) => {
      const fullPath = file.previousPath
        ? `${file.previousPath} ${file.path}`.toLowerCase()
        : file.path.toLowerCase();
      const basename = lastSegment(file.path).toLowerCase();
      return basename.includes(normalizedQuery) || fullPath.includes(normalizedQuery);
    });
  }, [commit, deferredFileQuery]);

  useEffect(() => {
    setFileQuery("");
  }, [commit?.sha]);

  if (!commit) {
    return <EmptyState title="请选择一个提交" description="左侧选中后会在这里显示详情。" />;
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={commit.sha}
        className="commit-detail-stack"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={PAGE_TRANSITION}
      >
        <Card
          className="commit-detail-card commit-detail-summary"
          contentClassName="commit-detail-card-content"
          title={`${commit.shortSha} ${commit.subject}`}
          subtitle={`${commit.authorName} · ${formatDateTime(commit.committedAt)}`}
        >
          <div className="commit-summary-inline">
            <span className="commit-inline-pill">涉及文件 {commit.filesChanged}</span>
            <span className="commit-inline-pill">+{commit.additions} / -{commit.deletions}</span>
            <span className="commit-inline-pill">原始事件数 {commit.observedCursorEventCount}</span>
            <span className="commit-inline-pill">哈希命中 {commit.evidenceSummary.aiHashMatchLines}</span>
            {commit.unknownLines > 0 ? <span className="commit-inline-pill warn">未识别 {commit.unknownLines} 行</span> : null}
          </div>

          <div className="meta-row">
            <Badge>{commit.isSelfAuthored ? "本人" : "团队"}</Badge>
            <Badge>{commit.models.join(", ") || "无 AI 模型"}</Badge>
            {commit.sessionIds.length > 0 ? <Badge>{commit.sessionIds.length} 个会话</Badge> : null}
            <Badge>{humanStrategyLabel(commit.humanStrategy)}</Badge>
          </div>
          {commit.observedCursorEventCount === 0 ? (
            <p className="diff-legend">诊断提示：此提交未命中 Cursor 原始事件（可能是 Keep / Accept 未触发 Hook），暂标记为未识别。</p>
          ) : null}
        </Card>

        <Card className="commit-detail-card commit-detail-diff" contentClassName="commit-detail-card-content" title="文件 Diff">
          <div className="commit-files-toolbar">
            <div className="commit-files-toolbar-meta">
              <span>按文件名筛选</span>
              <strong>{visibleFiles.length} / {commit.files.length}</strong>
            </div>
            <Input
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="过滤文件名"
              aria-label="过滤文件名"
            />
          </div>

          <div className="file-accordion">
            {visibleFiles.length === 0 ? (
              <EmptyState title="没有匹配的文件" description="试试换个文件名关键字。" compact />
            ) : visibleFiles.map((file) => {
              return (
                <div key={file.path} id={`file-diff-${file.path}`}>
                  <CommitFileAccordionItem
                    commitSha={commit.sha}
                    file={file}
                  />
                </div>
              );
            })}
          </div>
        </Card>
      </motion.div>
    </AnimatePresence>
  );
}

function HealthTab({ snapshot }: { snapshot: AppSnapshot | null }) {
  if (!snapshot) {
    return (
      <div className="hl-empty-wrap">
        <EmptyState title="准备中" description="正在读取仓库状态。" />
      </div>
    );
  }

  const raw = snapshot.rawTraceEvents ?? 0;
  const norm = snapshot.normalizedTraceEvents ?? 0;
  const humanS = snapshot.normalizedHumanSnapshotEvents ?? 0;
  const manual = snapshot.normalizedManualSnapshotEvents ?? 0;
  const recon = snapshot.normalizedReconcileSnapshotEvents ?? 0;
  const snaps = snapshot.fileSnapshots ?? 0;
  const ffOk = snapshot.canFastForward === true;
  const ffWarn = snapshot.canFastForward === false;

  return (
    <main className="hl-root">
      <section className="hl-pipeline-wrap">
        <div className="hl-section-title">采集链路</div>
        <div className="hl-pipeline">
          <div className="hl-node">
            <div className="hl-node-num ai">{raw.toLocaleString()}</div>
            <div className="hl-node-name">原始事件</div>
            <div className="hl-node-sub">Cursor Hook 采集</div>
          </div>
          <svg className="hl-arrow" width="24" height="16" viewBox="0 0 24 16" fill="none">
            <path d="M0 8h20M16 4l4 4-4 4" stroke="#363636" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="hl-node">
            <div className="hl-node-num blue">{norm.toLocaleString()}</div>
            <div className="hl-node-name">已标准化</div>
            <div className="hl-node-sub">结构化追踪数据</div>
          </div>
          <svg className="hl-arrow" width="24" height="16" viewBox="0 0 24 16" fill="none">
            <path d="M0 8h20M16 4l4 4-4 4" stroke="#363636" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="hl-node">
            <div className="hl-node-num human">{humanS.toLocaleString()}</div>
            <div className="hl-node-name">人工快照</div>
            <div className="hl-node-sub">手动 {manual} / 自动矫正 {recon}</div>
          </div>
          <svg className="hl-arrow" width="24" height="16" viewBox="0 0 24 16" fill="none">
            <path d="M0 8h20M16 4l4 4-4 4" stroke="#363636" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="hl-node">
            <div className="hl-node-num muted">{snaps.toLocaleString()}</div>
            <div className="hl-node-name">行快照库</div>
            <div className="hl-node-sub">归因哈希索引</div>
          </div>
        </div>
      </section>

      <section className="hl-status-grid">
        <div className={`hl-status-card ${ffOk ? "ok" : ffWarn ? "warn" : ""}`}>
          <div className={`hl-status-dot ${ffOk ? "ok" : ffWarn ? "warn" : "muted"}`} />
          <div className="hl-status-content">
            <strong>远程分支同步</strong>
            <span>{formatFastForward(snapshot.canFastForward)}</span>
            <small>超前 {snapshot.ahead ?? 0} / 落后 {snapshot.behind ?? 0}</small>
          </div>
        </div>
        <div className={`hl-status-card ${snapshot.issues.length === 0 ? "ok" : "warn"}`}>
          <div className={`hl-status-dot ${snapshot.issues.length === 0 ? "ok" : "warn"}`} />
          <div className="hl-status-content">
            <strong>系统健康诊断</strong>
            <span>{snapshot.issues.length === 0 ? "运行良好" : `${snapshot.issues.length} 个异常`}</span>
            <small>基于当前采集数据评估</small>
          </div>
        </div>
        <div className="hl-status-card">
          <div className="hl-status-dot muted" />
          <div className="hl-status-content">
            <strong>数据标准化率</strong>
            <span>{raw > 0 ? formatPercent(norm / raw * 100) : "—"}</span>
            <small>Normalized / Raw</small>
          </div>
        </div>
      </section>

      {snapshot.issues.length > 0 ? (
        <section className="hl-issues-section">
          <div className="hl-section-title hl-section-warn">异常详情</div>
          <ul className="hl-issues-list">
            {snapshot.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="hl-criteria-section">
        <div className="hl-section-title">归因口径</div>
        <div className="hl-criteria">
          <div className="hl-crit-row">
            <span className="hl-crit-tag ai">AI 生成</span>
            <p>基于 Cursor Hook 采集的实时快照，通过行哈希精确匹配。命中即归为 AI 生成。</p>
          </div>
          <div className="hl-crit-row">
            <span className="hl-crit-tag human">人工编写</span>
            <p>基于手动标记、自动同步快照（Reconcile），或在 AI 生成的代码段内进行手动改写。</p>
          </div>
          <div className="hl-crit-row">
            <span className="hl-crit-tag unknown">未识别</span>
            <p>证据不足时保留为未识别，避免在数据不全时对人工占比进行错误推断。</p>
          </div>
          <div className="hl-crit-row">
            <span className="hl-crit-tag removed">已删除</span>
            <p>被删除的代码行按 Git Diff 独立统计，不参与新增代码的归因占比计算。</p>
          </div>
        </div>
      </section>
    </main>
  );
}

function ConfigItem({
  label,
  value,
  source,
  defaultValue,
  description,
  fileKey,
}: {
  label: string;
  value: any;
  source: string;
  defaultValue: any;
  description: string;
  fileKey: string;
}) {
  const isDefault = source === "默认值" || source === "默认值（当前分支）";
  const displayValue = Array.isArray(value)
    ? (value.length > 0 ? value.join(", ") : "(空)")
    : String(value);

  const displayDefault = Array.isArray(defaultValue)
    ? (defaultValue.length > 0 ? `[${defaultValue.map(v => `"${v}"`).join(", ")}]` : "[]")
    : String(defaultValue);

  return (
    <div className="config-item dense">
      <div className="config-item-header">
        <div className="config-item-main-info">
          <span className="config-item-label">{label}</span>
          <code className="config-item-key">{fileKey}</code>
        </div>
        <span className={`config-item-source ${isAllChinese(source) ? "native" : ""}`}>{source}</span>
      </div>
      <div className="config-item-body">
        <div className="config-item-value-row">
          <div className="config-item-value">{displayValue}</div>
          <div className="config-item-default">默认: <code>{displayDefault}</code></div>
        </div>
        <div className="config-item-desc">{description}</div>
      </div>
    </div>
  );
}

function isAllChinese(str: string): boolean {
  return /^[\u4e00-\u9fa5（）]+$/.test(str);
}

function SettingsTab({ snapshot }: { snapshot: AppSnapshot | null }) {
  const config = snapshot?.loadedConfig?.config;
  const sources = snapshot?.loadedConfig?.sources;

  if (!snapshot) {
    return (
      <div className="hl-empty-wrap">
        <EmptyState title="正在加载配置" description="请稍候，正在同步仓库设置..." />
      </div>
    );
  }

  if (!config || !sources) {
    return (
      <div className="hl-empty-wrap">
        <EmptyState title="配置读取失败" description="无法解析当前仓库的有效配置，请尝试刷新。" />
      </div>
    );
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert("已复制到剪贴板");
  };

  const generateToml = (isLocal: boolean) => {
    const lines = isLocal
      ? ["# agent-tracker 本地覆盖配置", "# 仅对当前设备生效，不建议提交到仓库", ""]
      : ["# agent-tracker 项目配置", "# 建议提交到仓库与团队共享", ""];

    const fields = [
      { key: "target_branch", val: config.targetBranch, desc: "目标对比分支" },
      { key: "storage_root", val: config.storageRoot, desc: "本地追踪数据存储路径" },
      { key: "cursor_hooks_enabled", val: config.cursorHooksEnabled, desc: "是否启用 Cursor Hook 采集" },
      { key: "ff_check", val: config.ffCheck, desc: "是否检查 Fast-forward 状态" },
      { key: "fetch_before_compare", val: config.fetchBeforeCompare, desc: "对比前是否先执行 git fetch" },
      { key: "web_port", val: config.webPort, desc: "Web 服务监听端口" },
      { key: "self_emails", val: config.selfEmails, desc: "本人邮箱列表（用于识别作者）" },
      { key: "self_names", val: config.selfNames, desc: "本人姓名列表（用于识别作者）" },
      { key: "ignore", val: config.ignore, desc: "忽略统计的文件模式" },
    ];

    fields.forEach(f => {
      lines.push(`# ${f.desc}`);
      const valStr = Array.isArray(f.val)
        ? `[${f.val.map(v => `"${v}"`).join(", ")}]`
        : (typeof f.val === "string" ? `"${f.val}"` : String(f.val));
      lines.push(`${f.key} = ${valStr}`);
      lines.push("");
    });

    return lines.join("\n");
  };

  return (
    <div className="settings-scroll-container">
      <main className="settings-root dense-layout">
        <div className="settings-header-grid compact">
          <Card className="settings-info-card" contentClassName="settings-card-content" title="项目配置 (config.toml)">
            <div className="settings-file-info compact">
              <div className="file-path-row">
                <code className="file-path">{snapshot.projectConfigPath || ".agent-tracker/config.toml"}</code>
                <Badge tone={snapshot.projectConfigExists ? "ok" : "warn"}>{snapshot.projectConfigExists ? "已就绪" : "缺失"}</Badge>
              </div>
              <p className="file-desc">团队共享配置。建议提交至 Git 以统一全员统计口径。</p>
              <button className="copy-toml-btn x-small" onClick={() => copyToClipboard(generateToml(false))}>复制推荐模板</button>
            </div>
          </Card>

          <Card className="settings-info-card" contentClassName="settings-card-content" title="本地覆盖 (config.local.toml)">
            <div className="settings-file-info compact">
              <div className="file-path-row">
                <code className="file-path">{snapshot.localConfigPath || "config.local.toml"}</code>
                <Badge tone={snapshot.localConfigExists ? "ok" : "warn"}>{snapshot.localConfigExists ? "已生效" : "未启用"}</Badge>
              </div>
              <p className="file-desc">个人偏好。已被 .gitignore 忽略，不影响他人。</p>
              <button className="copy-toml-btn secondary x-small" onClick={() => copyToClipboard(generateToml(true))}>复制覆盖模板</button>
            </div>
          </Card>
        </div>

        <div className="settings-sections-stack">
          <section className="settings-section">
            <h3 className="settings-section-title">核心归因统计</h3>
            <div className="config-grid tight">
              <ConfigItem
                label="基准分支"
                fileKey="target_branch"
                value={config.targetBranch}
                source={sources.targetBranch}
                defaultValue="main"
                description="代码增量的计算基准。系统会自动分析当前分支相对于该分支的差异。通常设为生产主干或主开发分支。"
              />
              <ConfigItem
                label="忽略规则"
                fileKey="ignore"
                value={config.ignore}
                source={sources.ignore}
                defaultValue={['**/*.md', '**/*.lock', '**/bun.lockb']}
                description="支持 Glob 通配符。匹配的文件（如第三方库、资源文件、锁文件等）将完全排除在统计之外。"
              />
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">贡献者识别</h3>
            <div className="config-grid tight">
              <ConfigItem
                label="本人邮箱"
                fileKey="self_emails"
                value={config.selfEmails}
                source={sources.selfEmails}
                defaultValue={[]}
                description="Git 提交记录中的作者邮箱。如果你在不同设备使用多个邮箱，请全部列出，以便正确识别『本人』贡献。"
              />
              <ConfigItem
                label="本人姓名"
                fileKey="self_names"
                value={config.selfNames}
                source={sources.selfNames}
                defaultValue={[]}
                description="辅助方案。如果邮箱不匹配，系统会尝试对 Git 提交中的作者姓名进行不区分大小写的匹配。"
              />
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">系统集成与运行</h3>
            <div className="config-grid tight">
              <ConfigItem
                label="Cursor 采集"
                fileKey="cursor_hooks_enabled"
                value={config.cursorHooksEnabled}
                source={sources.cursorHooksEnabled}
                defaultValue={true}
                description="启用后，Cursor 每次生成代码都会触发 Hook 记录快照。这是实现高置信度 AI 归因的最核心数据源。"
              />
              <ConfigItem
                label="数据路径"
                fileKey="storage_root"
                value={config.storageRoot}
                source={sources.storageRoot}
                defaultValue=".git/agent-tracker"
                description="存储快照、索引和统计缓存的目录。默认放在 .git 下以避免污染工作区且防止被误提交。"
              />
              <ConfigItem
                label="Web 端口"
                fileKey="web_port"
                value={config.webPort}
                source={sources.webPort}
                defaultValue={3487}
                description="本仪表盘占用的本地端口。如果 3487 端口已被占用，你可以在 config.local.toml 中修改此项。"
              />
              <ConfigItem
                label="同步检查"
                fileKey="ff_check"
                value={config.ffCheck}
                source={sources.ffCheck}
                defaultValue={true}
                description="计算前是否检查基准分支已同步。若本地基准分支过旧，会导致 Diff 结果异常，严重影响准确性。"
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
  flush,
  className,
  contentClassName,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  flush?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <UICard className={[flush ? "overflow-hidden" : "", className].filter(Boolean).join(" ")}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {subtitle ? <CardDescription>{subtitle}</CardDescription> : null}
      </CardHeader>
      <CardContent className={[flush ? "p-0" : "", contentClassName].filter(Boolean).join(" ")}>{children}</CardContent>
    </UICard>
  );
}

function MetricCard({
  label,
  value,
  hint,
  accent,
  compact,
  progress,
}: {
  label: string;
  value: string;
  hint?: string;
  accent: "teal" | "blue" | "amber" | "slate" | "rose" | "green";
  compact?: boolean;
  progress?: number | null;
}) {
  return (
    <div className={`metric ${accent} ${compact ? "compact" : ""}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
      {typeof progress === "number" ? (
        <Progress className="metric-progress" value={progress} indicatorClassName={`progress-fill ${accent}`} />
      ) : null}
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: SnapshotTone }) {
  const variant = tone === "ok" ? "ok" : tone === "fail" ? "fail" : tone === "warn" ? "warn" : "default";
  return <UIBadge variant={variant}>{children}</UIBadge>;
}

function ToneBadge({
  tone,
  children,
}: {
  tone: SnapshotTone;
  children: React.ReactNode;
}) {
  return <UIBadge variant={tone === "ok" ? "ok" : tone === "fail" ? "fail" : "warn"}>{children}</UIBadge>;
}

function SegmentedTabs({
  items,
  activeId,
  onChange,
}: {
  items: Array<{ id: string; label: string }>;
  activeId: string;
  onChange: (value: string) => void;
}) {
  return (
    <Tabs value={activeId} onValueChange={onChange}>
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.id} value={item.id}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function InfoBlock({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="info-block">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function RatioBar({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: "ai" | "human" | "unknown";
}) {
  return (
    <div className="ratio-row">
      <div className="ratio-label">
        <span>{label}</span>
        <strong>{formatPercent(value)}</strong>
      </div>
      <Progress value={value} indicatorClassName={`ratio-fill ${tone}`} />
    </div>
  );
}

function EvidenceCard({
  title,
  tone,
  count,
  description,
}: {
  title: string;
  tone: "ai" | "human" | "unknown";
  count: string;
  description: string;
}) {
  return (
    <div className={`evidence-card ${tone}`}>
      <div className="evidence-card-head">
        <strong>{title}</strong>
        <span className={`evidence-dot ${tone}`} />
      </div>
      <span>{count}</span>
      <p>{description}</p>
    </div>
  );
}

function EmptyState({
  title,
  description,
  compact,
}: {
  title: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "compact" : ""}`.trim()}>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function InfoMini({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="info-mini">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => {
      startTransition(() => {
        setRoute(parseHash(window.location.hash));
      });
    };

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = (nextRoute: Route) => {
    startTransition(() => {
      const nextHash = buildHash(nextRoute);
      if (window.location.hash === nextHash) {
        setRoute(nextRoute);
        return;
      }

      window.location.hash = nextHash;
    });
  };

  return [route, navigate];
}

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#/, "");
  if (!clean || clean === "/") {
    return { kind: "overview" };
  }

  const segments = clean.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] === "health") {
    return { kind: "health" };
  }

  if (segments[0] === "settings") {
    return { kind: "settings" };
  }

  if (
    segments[0] === "commits"
    && typeof segments[1] === "string"
    && segments[2] === "file"
    && typeof segments[3] === "string"
  ) {
    return {
      kind: "file",
      sha: segments[1],
      path: segments.slice(3).join("/"),
    };
  }

  if (segments[0] === "commits" && typeof segments[1] === "string") {
    return {
      kind: "commits",
      sha: segments[1],
    };
  }

  if (segments[0] === "commits") {
    return { kind: "commits" };
  }

  return { kind: "overview" };
}

function buildHash(route: Route): string {
  if (route.kind === "overview") {
    return "#/";
  }

  if (route.kind === "health") {
    return "#/health";
  }

  if (route.kind === "settings") {
    return "#/settings";
  }

  if (route.kind === "file") {
    return `#/commits/${encodeURIComponent(route.sha)}/file/${route.path.split("/").map(encodeURIComponent).join("/")}`;
  }

  if (route.sha) {
    return `#/commits/${encodeURIComponent(route.sha)}`;
  }

  return "#/commits";
}

function filterCommits(
  commits: CommitDataSummary[],
  query: string,
  authorFilter: AuthorFilter,
  coverageFilter: CoverageFilter,
): CommitDataSummary[] {
  const normalizedQuery = query.trim().toLowerCase();

  return commits.filter((commit) => {
    if (authorFilter === "self" && !commit.isSelfAuthored) {
      return false;
    }

    if (authorFilter === "team" && commit.isSelfAuthored) {
      return false;
    }

    if (coverageFilter === "with-ai" && commit.aiLines === 0) {
      return false;
    }

    if (coverageFilter === "with-human" && commit.humanLines === 0) {
      return false;
    }

    if (coverageFilter === "review" && commit.unknownLines === 0) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const haystack = [
      commit.shortSha,
      commit.subject,
      commit.authorName,
      commit.authorEmail,
      ...commit.files.map((file) => file.path),
    ].join(" ").toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

function humanStrategyLabel(value: string): string {
  if (value === "manual_snapshot+reconcile_snapshot+rewrite_of_ai_line") {
    return "综合归因 (快照/Reconcile/改写)";
  }

  return value === "rewrite_of_ai_line" ? "AI 代码改写" : value;
}

function toneLabel(tone: SnapshotTone): string {
  if (tone === "ok") {
    return "已就绪";
  }

  if (tone === "fail") {
    return "已阻塞";
  }

  return "待接入";
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return `${value.toFixed(1)}%`;
}

function formatRelative(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} 小时前`;
  }

  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatFastForward(value: boolean | null | undefined): string {
  if (value === true) {
    return "可用";
  }

  if (value === false) {
    return "不满足";
  }

  return "未知";
}

function aggregateOverviewBranch(
  branchData: BranchDataSummary | null,
  authorFilter: AuthorFilter,
): BranchDataSummary | null {
  if (!branchData) {
    return null;
  }

  const commits = branchData.commits.filter((commit) => (
    authorFilter === "all"
      ? true
      : authorFilter === "self"
        ? commit.isSelfAuthored
        : !commit.isSelfAuthored
  ));
  const uniqueFiles = new Set<string>();
  const uniqueObservedFiles = new Set<string>();
  const ignoredFiles = new Set<string>();
  const models = new Set<string>();
  const aggregatedSessionIds = new Set<string>();
  const evidenceSummary: AttributionEvidenceSummary = {
    aiHashMatchLines: 0,
    humanSnapshotLines: 0,
    humanManualSnapshotLines: 0,
    humanReconcileSnapshotLines: 0,
    humanRewriteLines: 0,
    removedAiSourceLines: 0,
    removedHumanSourceLines: 0,
    removedUnknownSourceLines: 0,
  };

  let additions = 0;
  let deletions = 0;
  let observedCursorEventCount = 0;
  let observedAiAdditions = 0;
  let aiLines = 0;
  let humanLines = 0;
  let unknownLines = 0;
  let removedLines = 0;

  for (const commit of commits) {
    additions += commit.additions;
    deletions += commit.deletions;
    observedCursorEventCount += commit.observedCursorEventCount;
    observedAiAdditions += commit.observedAiAdditions;
    aiLines += commit.aiLines;
    humanLines += commit.humanLines;
    unknownLines += commit.unknownLines;
    removedLines += commit.removedLines;

    commit.models.forEach((model) => models.add(model));
    commit.sessionIds.forEach((sessionId) => aggregatedSessionIds.add(sessionId));
    for (const file of commit.files) {
      if (file.isIgnored) {
        ignoredFiles.add(file.path);
        continue;
      }

      uniqueFiles.add(file.path);
      if (file.observedEventCount > 0 || file.aiLines > 0) {
        uniqueObservedFiles.add(file.path);
      }
    }

    evidenceSummary.aiHashMatchLines += commit.evidenceSummary.aiHashMatchLines;
    evidenceSummary.humanSnapshotLines += commit.evidenceSummary.humanSnapshotLines;
    evidenceSummary.humanManualSnapshotLines += commit.evidenceSummary.humanManualSnapshotLines;
    evidenceSummary.humanReconcileSnapshotLines += commit.evidenceSummary.humanReconcileSnapshotLines;
    evidenceSummary.humanRewriteLines += commit.evidenceSummary.humanRewriteLines;
    evidenceSummary.removedAiSourceLines += commit.evidenceSummary.removedAiSourceLines;
    evidenceSummary.removedHumanSourceLines += commit.evidenceSummary.removedHumanSourceLines;
    evidenceSummary.removedUnknownSourceLines += commit.evidenceSummary.removedUnknownSourceLines;
  }

  const changedLines = aiLines + humanLines + unknownLines;
  const observedAiFiles = uniqueObservedFiles.size;

  const isAll = authorFilter === "all";
  const finalSessionIds = isAll ? branchData.sessionIds : Array.from(aggregatedSessionIds);
  const finalRawEvents = isAll ? (branchData.rawTraceEventsConsidered ?? observedCursorEventCount) : observedCursorEventCount;

  return {
    ...branchData,
    commitCount: commits.length,
    selfCommitCount: commits.filter((commit) => commit.isSelfAuthored).length,
    teammateCommitCount: commits.filter((commit) => !commit.isSelfAuthored).length,
    filesChanged: uniqueFiles.size,
    ignoredFiles: ignoredFiles.size,
    additions,
    deletions,
    observedCursorEventCount: finalRawEvents,
    observedAiFiles,
    observedAiAdditions,
    aiLines,
    humanLines,
    unknownLines,
    removedLines,
    aiLineCoveragePercent: toPercentValue(aiLines, changedLines),
    humanLineCoveragePercent: toPercentValue(humanLines, changedLines),
    unknownLineCoveragePercent: toPercentValue(unknownLines, changedLines),
    observedFileCoveragePercent: toPercentValue(observedAiFiles, uniqueFiles.size),
    models: [...models],
    sessionIds: finalSessionIds,
    evidenceSummary,
    commits,
    recentCommits: commits.slice(-Math.min(commits.length, 10)),
  };
}

function toPercentValue(value: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }

  return Number(((value / total) * 100).toFixed(1));
}

createRoot(document.getElementById("root")!).render(<DashboardApp />);
