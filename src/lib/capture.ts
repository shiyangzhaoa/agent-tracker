import { format } from "node:util";

export interface CapturedCommandResult {
  exitCode: number;
  output: string;
}

export async function captureCommandOutput(run: () => Promise<number>): Promise<CapturedCommandResult> {
  const lines: string[] = [];
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => {
    lines.push(format(...args));
  };
  console.error = (...args: unknown[]) => {
    lines.push(format(...args));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(format(...args));
  };

  try {
    process.exitCode = 0;
    const exitCode = await run();

    return {
      exitCode,
      output: lines.join("\n").trim(),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.exitCode = originalExitCode;
  }
}
