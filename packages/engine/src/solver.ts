import { COLORS, type Color, type TileId, compareTileIds, isValidTileId, parseTile } from './tiles.js';

/** Configurable house rules for hand evaluation. */
export interface SolverConfig {
  /** Penalty for an unlinked Zhol wildcard. House-rule default: 20. */
  zholPenalty: number;
}

export const DEFAULT_ZHOL_PENALTY = 20;
export const DEFAULT_SOLVER_CONFIG: SolverConfig = { zholPenalty: DEFAULT_ZHOL_PENALTY };

export type LinkKind = 'run' | 'set';

/** One physical tile inside a link, with the face value it represents. */
export interface LinkSlot {
  id: TileId;
  color: Color;
  rank: number;
  /** True when this physical tile is a Zhol standing in for the given color/rank. */
  wildcard: boolean;
}

export interface Link {
  kind: LinkKind;
  /** Runs are ordered by rank; sets by color order. */
  slots: LinkSlot[];
}

export interface HandEvaluation {
  links: Link[];
  /** Unlinked physical tile IDs, canonical order. */
  unlinked: TileId[];
  /** Sum of unlinked tile penalties (minimum possible). */
  penalty: number;
  /** True when every tile belongs to a legal link. */
  fullCover: boolean;
}

interface Candidate {
  mask: number;
  kind: LinkKind;
  slots: { index: number; color: Color; rank: number; wildcard: boolean }[];
}

export function tilePenalty(id: TileId, config: SolverConfig = DEFAULT_SOLVER_CONFIG): number {
  const t = parseTile(id);
  return t.kind === 'zhol' ? config.zholPenalty : t.rank;
}

/**
 * Independent legality check for one group of physical tiles (no enumeration).
 * Used by the exhaustive reference solver in tests and for defensive checks.
 */
export function isLegalLink(ids: readonly TileId[]): boolean {
  if (ids.length < 3 || ids.length > 13) return false;
  if (new Set(ids).size !== ids.length || !ids.every(isValidTileId)) return false;
  const tiles = ids.map(parseTile);
  const numbered = tiles.filter((t): t is Extract<typeof t, { kind: 'number' }> => t.kind === 'number');
  if (numbered.length === 0) return false;

  // Set: 3–4 tiles, one rank, all different colors (Zhols stand in for missing colors).
  const rank0 = numbered[0]!.rank;
  if (
    ids.length <= 4 &&
    numbered.every((t) => t.rank === rank0) &&
    new Set(numbered.map((t) => t.color)).size === numbered.length
  ) {
    return true;
  }

  // Run: one color, distinct ranks, gaps fillable by Zhols, no wraparound, length ≤ 13.
  const color0 = numbered[0]!.color;
  if (!numbered.every((t) => t.color === color0)) return false;
  const ranks = numbered.map((t) => t.rank);
  if (new Set(ranks).size !== ranks.length) return false;
  const span = Math.max(...ranks) - Math.min(...ranks) + 1;
  return span <= ids.length;
}

/** Enumerate every legal candidate link (deduplicated by physical tile set). */
function enumerateCandidates(tiles: TileId[]): Candidate[] {
  const parsed = tiles.map(parseTile);
  const zhols: number[] = [];
  // byColorRank[color][rank] -> tile indices
  const byColorRank = new Map<Color, number[][]>();
  for (const c of COLORS) byColorRank.set(c, Array.from({ length: 14 }, () => []));
  parsed.forEach((t, i) => {
    if (t.kind === 'zhol') zhols.push(i);
    else byColorRank.get(t.color)![t.rank]!.push(i);
  });

  const seen = new Map<number, Candidate>();
  const emit = (cand: Candidate) => {
    if (!seen.has(cand.mask)) seen.set(cand.mask, cand);
  };

  // Runs
  for (const color of COLORS) {
    const ranks = byColorRank.get(color)!;
    for (let start = 1; start <= 11; start++) {
      const slots: Candidate['slots'] = [];
      const dfs = (rank: number, mask: number, usedZ: number) => {
        if (slots.length >= 3) emit({ mask, kind: 'run', slots: slots.slice() });
        if (rank > 13) return;
        for (const idx of ranks[rank]!) {
          slots.push({ index: idx, color, rank, wildcard: false });
          dfs(rank + 1, mask | (1 << idx), usedZ);
          slots.pop();
        }
        for (let z = 0; z < zhols.length; z++) {
          if (usedZ & (1 << z)) continue;
          const idx = zhols[z]!;
          slots.push({ index: idx, color, rank, wildcard: true });
          dfs(rank + 1, mask | (1 << idx), usedZ | (1 << z));
          slots.pop();
        }
      };
      dfs(start, 0, 0);
    }
  }

  // Sets
  for (let rank = 1; rank <= 13; rank++) {
    const perColor = COLORS.map((c) => byColorRank.get(c)![rank]!);
    const chosen: Candidate['slots'] = [];
    const pickColor = (ci: number, mask: number) => {
      if (ci === COLORS.length) {
        if (chosen.length === 0) return;
        const missing = COLORS.filter((c) => !chosen.some((s) => s.color === c));
        // Add 0, 1 or 2 Zhols (each a specific physical tile) for missing colors.
        const zhSubsets: number[][] = [[]];
        for (let a = 0; a < zhols.length; a++) {
          zhSubsets.push([zhols[a]!]);
          for (let b = a + 1; b < zhols.length; b++) zhSubsets.push([zhols[a]!, zhols[b]!]);
        }
        for (const zs of zhSubsets) {
          const size = chosen.length + zs.length;
          if (size < 3 || size > 4 || zs.length > missing.length) continue;
          let m = mask;
          const zSlots = zs.map((index, k) => {
            m |= 1 << index;
            return { index, color: missing[k]!, rank, wildcard: true };
          });
          const all = [...chosen, ...zSlots].sort(
            (x, y) => COLORS.indexOf(x.color) - COLORS.indexOf(y.color),
          );
          emit({ mask: m, kind: 'set', slots: all });
        }
        return;
      }
      pickColor(ci + 1, mask); // skip this color
      for (const idx of perColor[ci]!) {
        chosen.push({ index: idx, color: COLORS[ci]!, rank, wildcard: false });
        pickColor(ci + 1, mask | (1 << idx));
        chosen.pop();
      }
    };
    pickColor(0, 0);
  }

  return [...seen.values()];
}

/**
 * Exact minimum-penalty grouping of a hand.
 *
 * Tiles are first put in canonical order so the result never depends on rack
 * order. Memoized bitmask search: for the lowest remaining tile, try leaving
 * it unlinked, then every candidate link that contains it and fits in the
 * remaining set. Ties keep the first option found (unlinked first, then
 * candidates in enumeration order), which makes results deterministic.
 */
export function evaluateHand(ids: readonly TileId[], config: SolverConfig = DEFAULT_SOLVER_CONFIG): HandEvaluation {
  if (ids.length > 30) throw new Error('Hand too large to evaluate');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate tile IDs in hand');
  for (const id of ids) if (!isValidTileId(id)) throw new Error(`Invalid tile id: ${id}`);

  const tiles = [...ids].sort(compareTileIds);
  const n = tiles.length;
  const penalties = tiles.map((id) => tilePenalty(id, config));
  const candidates = enumerateCandidates(tiles);
  const byLowest: Candidate[][] = Array.from({ length: n }, () => []);
  for (const c of candidates) {
    const low = Math.log2(c.mask & -c.mask);
    byLowest[low]!.push(c);
  }

  const memo = new Map<number, { cost: number; pick: Candidate | null }>();
  const solve = (mask: number): number => {
    if (mask === 0) return 0;
    const hit = memo.get(mask);
    if (hit) return hit.cost;
    const low = Math.log2(mask & -mask);
    let best = penalties[low]! + solve(mask & ~(1 << low));
    let pick: Candidate | null = null;
    for (const c of byLowest[low]!) {
      if ((c.mask & mask) !== c.mask) continue;
      const v = solve(mask & ~c.mask);
      if (v < best) {
        best = v;
        pick = c;
      }
    }
    memo.set(mask, { cost: best, pick });
    return best;
  };

  const full = n === 0 ? 0 : n === 31 ? 0x7fffffff : (1 << n) - 1;
  const penalty = solve(full);

  const links: Link[] = [];
  const unlinked: TileId[] = [];
  let mask = full;
  while (mask !== 0) {
    const low = Math.log2(mask & -mask);
    const entry = memo.get(mask)!;
    if (entry.pick) {
      links.push({
        kind: entry.pick.kind,
        slots: entry.pick.slots.map((s) => ({ id: tiles[s.index]!, color: s.color, rank: s.rank, wildcard: s.wildcard })),
      });
      mask &= ~entry.pick.mask;
    } else {
      unlinked.push(tiles[low]!);
      mask &= ~(1 << low);
    }
  }

  return { links, unlinked, penalty, fullCover: unlinked.length === 0 };
}

export interface CloseCheck {
  valid: boolean;
  reason?: 'RACK_SIZE' | 'TILE_NOT_IN_RACK' | 'NOT_FULL_COVER';
  evaluation?: HandEvaluation;
}

/** Validate a close: discard one tile from a 15-tile rack; the other 14 must all be linked. */
export function checkClose(rack: readonly TileId[], finalDiscard: TileId, config: SolverConfig = DEFAULT_SOLVER_CONFIG): CloseCheck {
  if (rack.length !== 15) return { valid: false, reason: 'RACK_SIZE' };
  if (!rack.includes(finalDiscard)) return { valid: false, reason: 'TILE_NOT_IN_RACK' };
  const remaining = rack.filter((id) => id !== finalDiscard);
  const evaluation = evaluateHand(remaining, config);
  return evaluation.fullCover ? { valid: true, evaluation } : { valid: false, reason: 'NOT_FULL_COVER', evaluation };
}
