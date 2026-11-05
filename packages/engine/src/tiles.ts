/**
 * Physical tile inventory for Zhol.
 *
 * Every physical tile has a stable, unique ID:
 *   numbered tiles: `<color letter><rank 2 digits><copy a|b>`  e.g. "r07a", "k13b"
 *   Zhol wildcards: "z1", "z2"
 *
 * Color letters: r = Red, k = Black, u = Blue, y = Yellow.
 */

export const COLORS = ['red', 'black', 'blue', 'yellow'] as const;
export type Color = (typeof COLORS)[number];

export const COLOR_LETTER: Record<Color, string> = { red: 'r', black: 'k', blue: 'u', yellow: 'y' };
const LETTER_COLOR: Record<string, Color> = { r: 'red', k: 'black', u: 'blue', y: 'yellow' };

export const MIN_RANK = 1;
export const MAX_RANK = 13;
export const TOTAL_TILES = 106;
export const ZHOL_IDS = ['z1', 'z2'] as const;

export type TileId = string;

export type Tile =
  | { id: TileId; kind: 'number'; color: Color; rank: number }
  | { id: TileId; kind: 'zhol' };

const TILE_ID_RE = /^([rkuy])(0[1-9]|1[0-3])([ab])$/;

export function isValidTileId(id: unknown): id is TileId {
  return typeof id === 'string' && (TILE_ID_RE.test(id) || id === 'z1' || id === 'z2');
}

export function parseTile(id: TileId): Tile {
  if (id === 'z1' || id === 'z2') return { id, kind: 'zhol' };
  const m = TILE_ID_RE.exec(id);
  if (!m) throw new Error(`Invalid tile id: ${id}`);
  return { id, kind: 'number', color: LETTER_COLOR[m[1]!]!, rank: Number(m[2]) };
}

export function isZhol(id: TileId): boolean {
  return id === 'z1' || id === 'z2';
}

export function numberTileId(color: Color, rank: number, copy: 'a' | 'b'): TileId {
  return `${COLOR_LETTER[color]}${String(rank).padStart(2, '0')}${copy}`;
}

/** All 106 physical tiles in a fixed canonical order. */
export function createTileSet(): TileId[] {
  const ids: TileId[] = [];
  for (const color of COLORS) {
    for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
      ids.push(numberTileId(color, rank, 'a'), numberTileId(color, rank, 'b'));
    }
  }
  ids.push(...ZHOL_IDS);
  return ids;
}

const COLOR_INDEX: Record<Color, number> = { red: 0, black: 1, blue: 2, yellow: 3 };

/** Canonical comparison: color, rank, copy; Zhol tiles last. Used for determinism. */
export function compareTileIds(a: TileId, b: TileId): number {
  const ta = parseTile(a);
  const tb = parseTile(b);
  if (ta.kind === 'zhol' || tb.kind === 'zhol') {
    if (ta.kind === tb.kind) return a < b ? -1 : a > b ? 1 : 0;
    return ta.kind === 'zhol' ? 1 : -1;
  }
  if (ta.color !== tb.color) return COLOR_INDEX[ta.color] - COLOR_INDEX[tb.color];
  if (ta.rank !== tb.rank) return ta.rank - tb.rank;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function colorIndex(c: Color): number {
  return COLOR_INDEX[c];
}
