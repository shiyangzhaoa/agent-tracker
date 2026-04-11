export interface DiffPairing<T> {
  left?: T;
  right?: T;
}

export function pairDiffChangeBlock<T extends { text: string }>(
  removes: T[],
  adds: T[],
): Array<DiffPairing<T>> {
  const rows: Array<DiffPairing<T>> = [];
  const total = Math.max(removes.length, adds.length);

  // Keep split diff rows aligned to Git's original line order.
  // This favors stable line numbers over semantic re-pairing across the block.
  for (let index = 0; index < total; index += 1) {
    rows.push({
      left: removes[index],
      right: adds[index],
    });
  }

  return rows;
}
