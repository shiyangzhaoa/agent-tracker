import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import type { StatePaths } from "./config";
import { listFileSnapshotMetadata, readRawTraceEvents } from "./storage";
import { normalizeRawTraceEvent } from "./normalized-trace";

export interface TraceIndexSummary {
  normalizedEventCount: number;
  normalizedFileEditCount: number;
  fileSnapshotCount: number;
}

export async function syncTraceIndex(statePaths: StatePaths): Promise<TraceIndexSummary> {
  if (!existsSync(dirname(statePaths.indexFile))) {
    return {
      normalizedEventCount: 0,
      normalizedFileEditCount: 0,
      fileSnapshotCount: 0,
    };
  }

  const rawTraceReadResult = await readRawTraceEvents(statePaths);
  const snapshots = await listFileSnapshotMetadata(statePaths);
  const normalizedEvents = rawTraceReadResult.events.map(normalizeRawTraceEvent);
  const db = new Database(statePaths.indexFile, { create: true });

  try {
    ensureTraceIndexSchema(db);

    const insertEvent = db.prepare(`
      INSERT OR REPLACE INTO normalized_trace_events (
        id,
        recorded_at,
        hook_event_name,
        category,
        current_branch,
        relative_path,
        snapshot_id,
        content_hash,
        line_count,
        model,
        session_id,
        conversation_id,
        generation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSnapshot = db.prepare(`
      INSERT OR REPLACE INTO file_snapshots (
        snapshot_id,
        relative_path,
        content_hash,
        byte_size,
        line_count,
        line_hashes_json,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const writeAll = db.transaction(() => {
      for (const event of normalizedEvents) {
        insertEvent.run(
          event.id,
          event.recordedAt,
          event.hookEventName,
          event.category,
          event.currentBranch,
          event.relativePath,
          event.snapshotId,
          event.contentHash,
          event.lineCount,
          event.model,
          event.sessionId,
          event.conversationId,
          event.generationId,
        );
      }

      for (const snapshot of snapshots) {
        insertSnapshot.run(
          snapshot.snapshotId,
          snapshot.relativePath,
          snapshot.contentHash,
          snapshot.byteSize,
          snapshot.lineCount,
          JSON.stringify(snapshot.lineHashes),
          snapshot.capturedAt,
        );
      }
    });

    writeAll();

    const normalizedEventCount = readCount(
      db,
      "SELECT COUNT(*) AS count FROM normalized_trace_events",
    );
    const normalizedFileEditCount = readCount(
      db,
      "SELECT COUNT(*) AS count FROM normalized_trace_events WHERE category = 'file_edit'",
    );
    const fileSnapshotCount = readCount(
      db,
      "SELECT COUNT(*) AS count FROM file_snapshots",
    );

    return {
      normalizedEventCount,
      normalizedFileEditCount,
      fileSnapshotCount,
    };
  } finally {
    db.close();
  }
}

function ensureTraceIndexSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS normalized_trace_events (
      id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      hook_event_name TEXT NOT NULL,
      category TEXT NOT NULL,
      current_branch TEXT,
      relative_path TEXT,
      snapshot_id TEXT,
      content_hash TEXT,
      line_count INTEGER,
      model TEXT,
      session_id TEXT,
      conversation_id TEXT,
      generation_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_normalized_trace_events_branch_time
      ON normalized_trace_events (current_branch, recorded_at);

    CREATE INDEX IF NOT EXISTS idx_normalized_trace_events_file_time
      ON normalized_trace_events (relative_path, recorded_at);

    CREATE TABLE IF NOT EXISTS file_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      line_hashes_json TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
  `);
}

function readCount(db: Database, sql: string): number {
  const row = db.query(sql).get() as { count?: number } | null;
  return typeof row?.count === "number" ? row.count : 0;
}
