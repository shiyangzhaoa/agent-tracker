import { relative } from "node:path";

const LABELS: Record<StatusKind, string> = {
  ok: "[成功]",
  warn: "[注意]",
  fail: "[失败]",
  info: "[提示]",
};

type StatusKind = "ok" | "warn" | "fail" | "info";

export function printSection(title: string): void {
  console.log("");
  console.log(title);
}

export function printStatus(kind: StatusKind, message: string): void {
  console.log(`${LABELS[kind]} ${message}`);
}

export function printSubItem(message: string, indentLevel = 1): void {
  const prefix = "  ".repeat(indentLevel);
  console.log(`${prefix}${message}`);
}

export function formatPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  return rel.length > 0 && !rel.startsWith("..") ? rel : filePath;
}
