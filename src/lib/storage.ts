import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { StatePaths } from "./config";
import type { CapturedFileSnapshot } from "./file-snapshot";
import type { RawTraceEvent } from "./raw-trace";

export interface EnsureStateLayoutResult {
  created: string[];
}

export interface RawTraceSummary {
  fileCount: number;
  eventCount: number;
}

export interface RawTraceReadResult {
  events: RawTraceEvent[];
  invalidLineCount: number;
}

export interface FileSnapshotMetadata {
  snapshotId: string;
  relativePath: string;
  contentHash: string;
  byteSize: number;
  lineCount: number;
  lineHashes: string[];
  capturedAt: string;
}

export async function ensureStateLayout(statePaths: StatePaths): Promise<EnsureStateLayoutResult> {
  const created: string[] = [];

  if (!existsSync(statePaths.storageRoot)) {
    await mkdir(statePaths.storageRoot, { recursive: true });
    created.push("storageRoot");
  }
  if (!existsSync(statePaths.rawDir)) {
    await mkdir(statePaths.rawDir, { recursive: true });
    created.push("rawDir");
  }
  if (!existsSync(statePaths.cacheDir)) {
    await mkdir(statePaths.cacheDir, { recursive: true });
    created.push("cacheDir");
  }
  if (!existsSync(statePaths.snapshotsDir)) {
    await mkdir(statePaths.snapshotsDir, { recursive: true });
    created.push("snapshotsDir");
  }
  if (!existsSync(statePaths.indexFile)) {
    await writeFile(statePaths.indexFile, "", "utf8");
    created.push("indexFile");
  }

  return { created };
}

export async function summarizeRawTraces(statePaths: StatePaths): Promise<RawTraceSummary> {
  if (!existsSync(statePaths.rawDir)) {
    return { fileCount: 0, eventCount: 0 };
  }

  const entries = await readdir(statePaths.rawDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  let eventCount = 0;

  for (const entry of files) {
    const fullPath = `${statePaths.rawDir}/${entry.name}`;
    const contents = await readFile(fullPath, "utf8");
    eventCount += contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }

  return {
    fileCount: files.length,
    eventCount,
  };
}

export async function readRawTraceEvents(statePaths: StatePaths): Promise<RawTraceReadResult> {
  if (!existsSync(statePaths.rawDir)) {
    return { events: [], invalidLineCount: 0 };
  }

  const entries = await readdir(statePaths.rawDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const events: RawTraceEvent[] = [];
  let invalidLineCount = 0;

  for (const fileName of files) {
    const fullPath = join(statePaths.rawDir, fileName);
    const contents = await readFile(fullPath, "utf8");
    const lines = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RawTraceEvent;
        events.push(parsed);
      } catch {
        invalidLineCount += 1;
      }
    }
  }

  return {
    events,
    invalidLineCount,
  };
}

export async function appendRawTraceEvent(statePaths: StatePaths, event: RawTraceEvent): Promise<string> {
  await mkdir(statePaths.rawDir, { recursive: true });

  const datePrefix = event.recordedAt.slice(0, 10);
  const filePath = join(statePaths.rawDir, `${datePrefix}.jsonl`);
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");

  return filePath;
}

export async function appendFileSnapshot(
  statePaths: StatePaths,
  snapshot: CapturedFileSnapshot,
): Promise<string> {
  await mkdir(statePaths.snapshotsDir, { recursive: true });

  const filePath = join(statePaths.snapshotsDir, `${snapshot.snapshotId}.json`);
  if (existsSync(filePath)) {
    return filePath;
  }

  const payload: FileSnapshotMetadata & { content: string } = {
    snapshotId: snapshot.snapshotId,
    relativePath: snapshot.relativePath,
    contentHash: snapshot.contentHash,
    byteSize: snapshot.byteSize,
    lineCount: snapshot.lineCount,
    lineHashes: snapshot.lineHashes,
    capturedAt: snapshot.capturedAt,
    content: snapshot.content,
  };
  await writeFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");

  return filePath;
}

export async function listFileSnapshotMetadata(statePaths: StatePaths): Promise<FileSnapshotMetadata[]> {
  if (!existsSync(statePaths.snapshotsDir)) {
    return [];
  }

  const entries = await readdir(statePaths.snapshotsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const snapshots: FileSnapshotMetadata[] = [];

  for (const fileName of files) {
    try {
      const fullPath = join(statePaths.snapshotsDir, fileName);
      const contents = await readFile(fullPath, "utf8");
      const parsed = JSON.parse(contents) as FileSnapshotMetadata;
      snapshots.push(parsed);
    } catch {
      // Ignore malformed snapshot cache entries for now.
    }
  }

  return snapshots;
}

export async function appendHookErrorLog(statePaths: StatePaths, message: string): Promise<string> {
  await mkdir(statePaths.storageRoot, { recursive: true });

  const filePath = join(statePaths.storageRoot, "hook-errors.log");
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await appendFile(filePath, line, "utf8");

  return filePath;
}
