import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

const MAX_SNAPSHOT_BYTES = 256 * 1024;

export interface CapturedFileSnapshot {
  snapshotId: string;
  relativePath: string;
  contentHash: string;
  byteSize: number;
  lineCount: number;
  lineHashes: string[];
  capturedAt: string;
  content: string;
}

export async function captureFileSnapshot(
  repoRoot: string,
  filePath: string,
  capturedAt: string,
): Promise<CapturedFileSnapshot | null> {
  const relativePath = toRepoRelativePath(repoRoot, filePath);
  if (!relativePath) {
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return null;
  }

  if (buffer.byteLength > MAX_SNAPSHOT_BYTES || looksBinary(buffer)) {
    return null;
  }

  const content = buffer.toString('utf8');
  const contentHash = hashText(content);
  const lines = splitLines(content);
  const lineHashes = lines.map((line) => hashText(line));

  return {
    snapshotId: contentHash,
    relativePath,
    contentHash,
    byteSize: buffer.byteLength,
    lineCount: lines.length,
    lineHashes,
    capturedAt,
    content,
  };
}

function toRepoRelativePath(repoRoot: string, filePath: string): string | null {
  const repoRelativePath = relative(repoRoot, filePath);
  if (!repoRelativePath || repoRelativePath.startsWith('..')) {
    return null;
  }

  return repoRelativePath;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
