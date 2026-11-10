import {
  type DealPlan,
  type GameMode,
  type GameState,
  type Rng,
  type TileId,
  applyAction,
  createGame,
  createSeededRng,
  createTileSet,
  isZhol,
  seatPlayer,
  OPENING_STOCK,
} from '../src/index.js';

export const ids = (s: string): TileId[] => s.split(/\s+/).filter(Boolean);

/**
 * Build a full, conserving deal plan. `racks[i]` lists tiles for the seat i
 * places clockwise from the starter; short racks are filled from the leftover
 * pool. `stockTop` puts specific tiles at the top of the stock.
 */
export function rigPlan(racks: TileId[][], opts: { stockTop?: TileId[]; stockBottom?: TileId[]; indicator?: TileId } = {}): DealPlan {
  const used = new Set<TileId>([...racks.flat(), ...(opts.stockTop ?? []), ...(opts.stockBottom ?? [])]);
  if (opts.indicator) used.add(opts.indicator);
  if (used.size !== racks.flat().length + (opts.stockTop?.length ?? 0) + (opts.stockBottom?.length ?? 0) + (opts.indicator ? 1 : 0)) {
    throw new Error('rigPlan: duplicate tiles');
  }
  const pool = createTileSet().filter((id) => !used.has(id));
  const indicator = opts.indicator ?? pool.splice(pool.findIndex((id) => !isZhol(id)), 1)[0]!;
  const filled = racks.map((r, i) => {
    const need = (i === 0 ? 15 : 14) - r.length;
    return [...r, ...pool.splice(0, need)];
  });
  while (filled.length < 4) filled.push(pool.splice(0, filled.length === 0 ? 15 : 14));
  const middle = OPENING_STOCK - (opts.stockTop?.length ?? 0) - (opts.stockBottom?.length ?? 0);
  const stock = [...(opts.stockTop ?? []), ...pool.splice(0, middle), ...(opts.stockBottom ?? [])];
  return { indicator, racks: filled, stock };
}

/** A game with four seated players. */
export function seatedGame(mode: GameMode = 'klasik'): GameState {
  let s = createGame({}, mode);
  for (let i = 0; i < 4; i++) {
    const r = seatPlayer(s, i);
    if (!r.ok) throw new Error(r.code);
    s = r.state;
  }
  return s;
}

/** Ready everyone with an optional queue of rigged plans; returns the dealt state. */
export function startGame(plans: DealPlan[] = [], rng: Rng = createSeededRng(1), mode: GameMode = 'klasik') {
  const queue = [...plans];
  const ctx = { rng, takeDealPlan: () => queue.shift() };
  let s = seatedGame(mode);
  for (let i = 0; i < 4; i++) s = must(applyAction(s, i, { type: 'ready', ready: true }, ctx)).state;
  return { state: s, ctx, queue };
}

export function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`Expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

// Reusable hands (physical copies chosen so they never collide).
export const STARTER_WIN = ids('r01a r02a r03a r04a u05a u06a u07a k09a k10a k11a r12a u12a k12a y12a');
export const LOSER_17 = ids('r01b r02b r03b u08b u09b u10b y07b y08b y09b k05b k06b k07b r05b k12b');
export const LOSER_ZERO = ids('u01b u02b u03b k01b k02b k03b y10b y11b y12b r08b r09b r10b r11b r12b');
export const LOSER_6 = ids('r05a k05a u05b y05a r09a k09b u09a y09a r13a k13a u13a y13a k01a z1');
export const FULL_A = ids('r01b r02b r03b r04b u08b u09b u10b y07b y08b y09b k05b k06b k07b k08b');
export const FULL_C = ids('r06a k06a u06b y06a r10a k10b u10a y10a k04a u04a y04a u11b u12b u13b');
