import { pairDiffChangeBlock } from "./diff-pairing";

export interface SplitDiffInputLine {
  kind: "context" | "remove" | "add";
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface SplitDiffCodeCell<TLine extends SplitDiffInputLine> {
  lineNumber: number | null;
  kind: "context" | "remove" | "add";
  text: string;
  source: TLine;
}

export type SplitDiffRow<TLine extends SplitDiffInputLine> =
  | { kind: "hunk"; key: string; header: string }
  | {
    kind: "code";
    key: string;
    left?: SplitDiffCodeCell<TLine>;
    right?: SplitDiffCodeCell<TLine>;
  };

export function buildSplitDiffRows<TLine extends SplitDiffInputLine>(
  hunks: Array<{ header: string; lines: TLine[] }>,
  options?: {
    includeContext?: boolean;
    normalizeText?: (value: string) => string;
  },
): Array<SplitDiffRow<TLine>> {
  const rows: Array<SplitDiffRow<TLine>> = [];
  const includeContext = options?.includeContext ?? true;
  const normalizeText = options?.normalizeText ?? ((value: string) => value);

  for (const hunk of hunks) {
    rows.push({
      kind: "hunk",
      key: `hunk:${hunk.header}`,
      header: hunk.header,
    });

    for (let index = 0; index < hunk.lines.length; index += 1) {
      const line = hunk.lines[index];
      if (!line) {
        continue;
      }

      if (line.kind === "context") {
        if (!includeContext) {
          continue;
        }

        rows.push({
          kind: "code",
          key: `ctx:${hunk.header}:${index}`,
          left: {
            lineNumber: line.oldLineNumber,
            kind: "context",
            text: normalizeText(line.text),
            source: line,
          },
          right: {
            lineNumber: line.newLineNumber,
            kind: "context",
            text: normalizeText(line.text),
            source: line,
          },
        });
        continue;
      }

      if (line.kind === "remove") {
        const removes: TLine[] = [];
        const adds: TLine[] = [];

        let cursor = index;
        while (hunk.lines[cursor]?.kind === "remove") {
          const next = hunk.lines[cursor];
          if (next) {
            removes.push(next);
          }
          cursor += 1;
        }

        while (hunk.lines[cursor]?.kind === "add") {
          const next = hunk.lines[cursor];
          if (next) {
            adds.push(next);
          }
          cursor += 1;
        }

        pairDiffChangeBlock(removes, adds).forEach((pair, pairIndex) => {
          rows.push({
            kind: "code",
            key: `pair:${hunk.header}:${index}:${pairIndex}`,
            left: pair.left
              ? {
                lineNumber: pair.left.oldLineNumber,
                kind: "remove",
                text: normalizeText(pair.left.text),
                source: pair.left,
              }
              : undefined,
            right: pair.right
              ? {
                lineNumber: pair.right.newLineNumber,
                kind: "add",
                text: normalizeText(pair.right.text),
                source: pair.right,
              }
              : undefined,
          });
        });

        index = cursor - 1;
        continue;
      }

      rows.push({
        kind: "code",
        key: `add:${hunk.header}:${index}`,
        right: {
          lineNumber: line.newLineNumber,
          kind: "add",
          text: normalizeText(line.text),
          source: line,
        },
      });
    }
  }

  return rows;
}
