export type ReorderableSpace = Readonly<{
  currentRevision: number;
  id: string;
  sortKey: string;
}>;

export type SpaceRankUpdate = Readonly<{
  currentRevision: number;
  id: string;
  sortKey: string;
}>;

export function rankSpacesAfterMove(
  spaces: readonly ReorderableSpace[],
  index: number,
  direction: -1 | 1
): readonly SpaceRankUpdate[] {
  const destination = index + direction;
  if (index < 0 || index >= spaces.length || destination < 0 || destination >= spaces.length) {
    return [];
  }

  const ordered = [...spaces];
  const current = ordered[index];
  const adjacent = ordered[destination];
  if (current === undefined || adjacent === undefined) return [];
  ordered[index] = adjacent;
  ordered[destination] = current;

  return ordered.flatMap((space, rank) => {
    const sortKey = `r${String(rank).padStart(6, "0")}`;
    return space.sortKey === sortKey
      ? []
      : [{ id: space.id, currentRevision: space.currentRevision, sortKey }];
  });
}
