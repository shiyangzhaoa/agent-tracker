export function isTrackerManagedPath(filePath: string): boolean {
  const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");

  if (normalizedPath === ".cursor/hooks.json") {
    return true;
  }

  if (normalizedPath === ".cursor/hooks/agent-tracker-hook.sh") {
    return true;
  }

  if (normalizedPath === ".agent-tracker" || normalizedPath.startsWith(".agent-tracker/")) {
    return true;
  }

  if (normalizedPath === ".git/agent-tracker" || normalizedPath.startsWith(".git/agent-tracker/")) {
    return true;
  }

  return false;
}

export function isIgnoredPath(filePath: string, ignorePatterns: string[]): boolean {
  if (isTrackerManagedPath(filePath)) {
    return true;
  }

  const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");

  for (const pattern of ignorePatterns) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(normalizedPath)) {
      return true;
    }
  }

  return false;
}
