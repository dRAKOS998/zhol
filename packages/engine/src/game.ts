import { type Rng, shuffleInPlace } from './rng.js';
import { type HandEvaluation, type SolverConfig, DEFAULT_SOLVER_CONFIG, checkClose, evaluateHand } from './solver.js';
import { type TileId, TOTAL_TILES, compareTileIds, createTileSet, isZhol } from './tiles.js';

export const SEAT_COUNT = 4;
export const ROUND_COUNT = 4;
export const SLOTS_PER_ROW = 12;
export const RACK_SLOTS = SLOTS_PER_ROW * 2;
export const STARTER_TILES = 15;
export const OTHER_TILES = 14;
export const OPENING_STOCK = TOTAL_TILES - STARTER_TILES - OTHER_TILES * 3 - 1; // 48

export const WIN_SCORE = -20;
export const ZHOL_WIN_SCORE = -40;

export type Phase = 'LOBBY' | 'AWAITING_DRAW' | 'AWAITING_DISCARD' | 'ROUND_RESULT' | 'TOURNAMENT_COMPLETE';
export type DrawSource = 'stock' | 'previous_discard';
export type FinishType = 'normal' | 'zhol';

export interface RackEntry {
  id: TileId;
  /** 0..RACK_SLOTS-1. Slots 0–11 are the upper tier, 12–23 the lower tier. */
  slot: number;
}

export interface DealState {
  dealId: string;
  roundNumber: number;
  starter: number;
  active: number;
  /** Increments on every draw/discard; used to reject stale gameplay commands. */
  turnId: number;
  /** Per seat, ordered by slot. */
  racks: RackEntry[][];
  /** Index 0 is the top of the hidden stock. */
  stock: TileId[];
  /** Per seat; last element is the face-up top. */
  discards: TileId[][];
  indicator: TileId;
}

export interface RoundResult {
  roundNumber: number;
  dealId: string;
  winner: number;
  finishType: FinishType;
  finalDiscard: TileId;
  /** Minimum unlinked penalty per seat (winner = 0). */
  penalties: number[];
  /** Signed score change per seat. */
  deltas: number[];
  /** Cumulative totals after this round. */
  totals: number[];
}

export type GameEvent =
  | { type: 'deal_started'; dealId: string; roundNumber: number; starter: number }
  | { type: 'deal_blocked'; blockedDealId: string; dealId: string; roundNumber: number }
  | { type: 'drew'; seat: number; source: DrawSource }
  | { type: 'discarded'; seat: number; tileId: TileId }
  | { type: 'round_scored'; result: RoundResult }
  | { type: 'tournament_complete'; winners: number[]; totals: number[] };

export type GameConfig = SolverConfig;

export interface GameState {
  schema: 1;
  phase: Phase;
  seated: boolean[];
  ready: boolean[];
  firstStarter: number | null;
  /** Round being played (or just scored). 0 before the first deal. */
  roundNumber: number;
  results: RoundResult[];
  dealSeq: number;
  /** Blocked deals in the current round. */
  blockedDeals: number;
  deal: DealState | null;
  lastEvent: GameEvent | null;
  config: GameConfig;
}

export type EngineErrorCode =
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'STALE_DEAL'
  | 'STALE_TURN'
  | 'EMPTY_STOCK'
  | 'EMPTY_DISCARD'
  | 'TILE_NOT_IN_RACK'
  | 'INVALID_PERMUTATION'
  | 'INVALID_CLOSE'
  | 'TOURNAMENT_COMPLETE'
  | 'NOT_SEATED'
  | 'SEAT_TAKEN'
  | 'INVALID_SEAT';

export type GameAction =
  | { type: 'ready'; ready: boolean }
  | { type: 'draw'; source: DrawSource; dealId: string; turnId: number }
  | { type: 'discard'; tileId: TileId; dealId: string; turnId: number }
  | { type: 'declare_win'; tileId: TileId; dealId: string; turnId: number }
  | { type: 'sort'; dealId: string; placements: RackEntry[] };

export interface EngineError {
  ok: false;
  code: EngineErrorCode;
  details?: Record<string, unknown>;
}
export interface EngineSuccess {
  ok: true;
  state: GameState;
  events: GameEvent[];
}
export type ApplyResult = EngineSuccess | EngineError;

/** A deal described tile-by-tile. racks[0] belongs to the starter; others follow clockwise. */
export interface DealPlan {
  indicator: TileId;
  racks: TileId[][];
  /** Index 0 is drawn first. */
  stock: TileId[];
}

export interface ApplyContext {
  rng: Rng;
  /** Test harness only: use this plan for the next deal instead of shuffling. */
  takeDealPlan?: () => DealPlan | undefined;
}

/** Game state is plain JSON data, so a JSON round-trip is a faithful deep copy in every runtime. */
const cloneState = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const fail = (code: EngineErrorCode, details?: Record<string, unknown>): EngineError => ({ ok: false, code, details });

export const nextSeat = (seat: number) => (seat + 1) % SEAT_COUNT;
export const previousSeat = (seat: number) => (seat + SEAT_COUNT - 1) % SEAT_COUNT;

export function createGame(config: Partial<GameConfig> = {}): GameState {
  return {
    schema: 1,
    phase: 'LOBBY',
    seated: [false, false, false, false],
    ready: [false, false, false, false],
    firstStarter: null,
    roundNumber: 0,
    results: [],
    dealSeq: 0,
    blockedDeals: 0,
    deal: null,
    lastEvent: null,
    config: { ...DEFAULT_SOLVER_CONFIG, ...config },
  };
}

export function totalsOf(state: Pick<GameState, 'results'>): number[] {
  return state.results.at(-1)?.totals.slice() ?? [0, 0, 0, 0];
}

/** Seats sharing the lowest cumulative total. */
export function tournamentWinners(totals: readonly number[]): number[] {
  const min = Math.min(...totals);
  return totals.flatMap((t, i) => (t === min ? [i] : []));
}

export function starterForRound(firstStarter: number, roundNumber: number): number {
  return (firstStarter + roundNumber - 1) % SEAT_COUNT;
}

/** Shuffle with Fisher–Yates, pick a uniform numbered indicator, deal 15/14/14/14, rest to stock. */
export function createRandomDealPlan(rng: Rng): DealPlan {
  const tiles = shuffleInPlace(createTileSet(), rng);
  const numbered = tiles.filter((id) => !isZhol(id));
  const indicator = numbered[rng.int(numbered.length)]!;
  const rest = tiles.filter((id) => id !== indicator);
  const racks: TileId[][] = [];
  let cursor = 0;
  for (let i = 0; i < SEAT_COUNT; i++) {
    const n = i === 0 ? STARTER_TILES : OTHER_TILES;
    racks.push(rest.slice(cursor, cursor + n));
    cursor += n;
  }
  return { indicator, racks, stock: rest.slice(cursor) };
}

/** Throws if a deal plan violates the opening invariant (57 + 1 + 48 = 106, unique tiles). */
export function assertValidDealPlan(plan: DealPlan): void {
  if (plan.racks.length !== SEAT_COUNT) throw new Error('Deal plan needs four racks');
  if (plan.racks[0]!.length !== STARTER_TILES) throw new Error('Starter must receive 15 tiles');
  for (let i = 1; i < SEAT_COUNT; i++) if (plan.racks[i]!.length !== OTHER_TILES) throw new Error('Other seats receive 14 tiles');
  if (plan.stock.length !== OPENING_STOCK) throw new Error('Stock must hold 48 tiles');
  if (isZhol(plan.indicator)) throw new Error('Indicator must be a numbered tile');
  const all = [...plan.racks.flat(), plan.indicator, ...plan.stock];
  const universe = new Set(createTileSet());
  if (all.length !== TOTAL_TILES || new Set(all).size !== TOTAL_TILES || !all.every((id) => universe.has(id))) {
    throw new Error('Deal plan does not conserve the 106 physical tiles');
  }
}

/** Assert tile conservation for a live deal (racks + stock + discards + indicator = 106). */
export function assertDealConservation(deal: DealState): void {
  const all = [...deal.racks.flatMap((r) => r.map((e) => e.id)), ...deal.stock, ...deal.discards.flat(), deal.indicator];
  if (all.length !== TOTAL_TILES || new Set(all).size !== TOTAL_TILES) throw new Error('Tile conservation violated');
}

function initialRack(ids: TileId[]): RackEntry[] {
  return [...ids].sort(compareTileIds).map((id, slot) => ({ id, slot }));
}

function startDeal(state: GameState, starter: number, ctx: ApplyContext): GameEvent {
  const plan = ctx.takeDealPlan?.() ?? createRandomDealPlan(ctx.rng);
  assertValidDealPlan(plan);
  state.dealSeq += 1;
  const racks: RackEntry[][] = [[], [], [], []];
  for (let i = 0; i < SEAT_COUNT; i++) racks[(starter + i) % SEAT_COUNT] = initialRack(plan.racks[i]!);
  state.deal = {
    dealId: `d${state.dealSeq}`,
    roundNumber: state.roundNumber,
    starter,
    active: starter,
    turnId: 1,
    racks,
    stock: plan.stock.slice(),
    discards: [[], [], [], []],
    indicator: plan.indicator,
  };
  assertDealConservation(state.deal);
  state.phase = 'AWAITING_DISCARD';
  state.ready = [false, false, false, false];
  return { type: 'deal_started', dealId: state.deal.dealId, roundNumber: state.roundNumber, starter };
}

function freeSlotFor(rack: RackEntry[]): number {
  const used = new Set(rack.map((e) => e.slot));
  const last = rack.reduce((m, e) => Math.max(m, e.slot), -1);
  for (let s = last + 1; s < RACK_SLOTS; s++) if (!used.has(s)) return s;
  for (let s = 0; s < RACK_SLOTS; s++) if (!used.has(s)) return s;
  throw new Error('Rack is full');
}

function sortRack(rack: RackEntry[]): RackEntry[] {
  return rack.sort((a, b) => a.slot - b.slot);
}

export function rackIds(deal: DealState, seat: number): TileId[] {
  return deal.racks[seat]!.map((e) => e.id);
}

/** Seat a player in the lobby (the server chooses the seat index). */
export function seatPlayer(state: GameState, seat: number): ApplyResult {
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) return fail('INVALID_SEAT');
  if (state.phase !== 'LOBBY') return fail('WRONG_PHASE');
  if (state.seated[seat]) return fail('SEAT_TAKEN');
  const next = cloneState(state);
  next.seated[seat] = true;
  return { ok: true, state: next, events: [] };
}

/** Pure reducer: validate and apply one action for `seat`. Never mutates the input. */
export function applyAction(state: GameState, seat: number, action: GameAction, ctx: ApplyContext): ApplyResult {
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) return fail('INVALID_SEAT');
  if (!state.seated[seat]) return fail('NOT_SEATED');
  if (state.phase === 'TOURNAMENT_COMPLETE') return fail('TOURNAMENT_COMPLETE');
  const next = cloneState(state);
  const events: GameEvent[] = [];
  const done = (): ApplyResult => {
    if (events.length) next.lastEvent = events.at(-1)!;
    if (next.deal) assertDealConservation(next.deal);
    return { ok: true, state: next, events };
  };

  if (action.type === 'ready') {
    if (next.phase !== 'LOBBY' && next.phase !== 'ROUND_RESULT') return fail('WRONG_PHASE');
    next.ready[seat] = action.ready;
    const everyone = next.seated.every(Boolean) && next.ready.every(Boolean);
    if (everyone) {
      if (next.phase === 'LOBBY') {
        next.firstStarter = ctx.rng.int(SEAT_COUNT);
        next.roundNumber = 1;
      } else {
        next.roundNumber += 1;
      }
      next.blockedDeals = 0;
      events.push(startDeal(next, starterForRound(next.firstStarter!, next.roundNumber), ctx));
    }
    return done();
  }

  const deal = next.deal;
  if (!deal || (next.phase !== 'AWAITING_DRAW' && next.phase !== 'AWAITING_DISCARD')) return fail('WRONG_PHASE');
  if (action.dealId !== deal.dealId) return fail('STALE_DEAL', { currentDealId: deal.dealId });

  if (action.type === 'sort') {
    const rack = deal.racks[seat]!;
    const ids = action.placements.map((p) => p.id);
    const slots = action.placements.map((p) => p.slot);
    const current = new Set(rack.map((e) => e.id));
    const valid =
      ids.length === rack.length &&
      new Set(ids).size === ids.length &&
      ids.every((id) => current.has(id)) &&
      new Set(slots).size === slots.length &&
      slots.every((s) => Number.isInteger(s) && s >= 0 && s < RACK_SLOTS);
    if (!valid) return fail('INVALID_PERMUTATION');
    deal.racks[seat] = sortRack(action.placements.map((p) => ({ id: p.id, slot: p.slot })));
    return done();
  }

  if (action.turnId !== deal.turnId) return fail('STALE_TURN', { currentTurnId: deal.turnId });
  if (seat !== deal.active) return fail('NOT_YOUR_TURN');
  const rack = deal.racks[seat]!;

  switch (action.type) {
    case 'draw': {
      if (next.phase !== 'AWAITING_DRAW') return fail('WRONG_PHASE');
      let tile: TileId | undefined;
      if (action.source === 'stock') {
        tile = deal.stock.shift();
        if (!tile) return fail('EMPTY_STOCK');
      } else {
        tile = deal.discards[previousSeat(seat)]!.pop();
        if (!tile) return fail('EMPTY_DISCARD');
      }
      rack.push({ id: tile, slot: freeSlotFor(rack) });
      sortRack(rack);
      deal.turnId += 1;
      next.phase = 'AWAITING_DISCARD';
      events.push({ type: 'drew', seat, source: action.source });
      return done();
    }
    case 'discard': {
      if (next.phase !== 'AWAITING_DISCARD') return fail('WRONG_PHASE');
      const idx = rack.findIndex((e) => e.id === action.tileId);
      if (idx < 0) return fail('TILE_NOT_IN_RACK');
      rack.splice(idx, 1);
      deal.discards[seat]!.push(action.tileId);
      deal.turnId += 1;
      events.push({ type: 'discarded', seat, tileId: action.tileId });
      if (deal.stock.length === 0) {
        // Stock exhausted and the player who drew the last tile did not close: blocked deal.
        const blockedDealId = deal.dealId;
        next.blockedDeals += 1;
        startDeal(next, deal.starter, ctx);
        events.push({ type: 'deal_blocked', blockedDealId, dealId: next.deal!.dealId, roundNumber: next.roundNumber });
        return done();
      }
      deal.active = nextSeat(seat);
      next.phase = 'AWAITING_DRAW';
      return done();
    }
    case 'declare_win': {
      if (next.phase !== 'AWAITING_DISCARD') return fail('WRONG_PHASE');
      const ids = rack.map((e) => e.id);
      const check = checkClose(ids, action.tileId, next.config);
      if (!check.valid) {
        return fail('INVALID_CLOSE', {
          reason: check.reason,
          unlinkedCount: check.evaluation?.unlinked.length ?? null,
        });
      }
      rack.splice(ids.indexOf(action.tileId), 1);
      deal.discards[seat]!.push(action.tileId);
      deal.turnId += 1;

      const finishType: FinishType = isZhol(action.tileId) ? 'zhol' : 'normal';
      const penalties = [0, 0, 0, 0];
      const deltas = [0, 0, 0, 0];
      for (let s = 0; s < SEAT_COUNT; s++) {
        if (s === seat) {
          deltas[s] = finishType === 'zhol' ? ZHOL_WIN_SCORE : WIN_SCORE;
        } else {
          const evaluation: HandEvaluation = evaluateHand(rackIds(deal, s), next.config);
          penalties[s] = evaluation.penalty;
          deltas[s] = evaluation.penalty;
        }
      }
      const prev = totalsOf(next);
      const totals = prev.map((t, i) => t + deltas[i]!);
      const result: RoundResult = {
        roundNumber: next.roundNumber,
        dealId: deal.dealId,
        winner: seat,
        finishType,
        finalDiscard: action.tileId,
        penalties,
        deltas,
        totals,
      };
      next.results.push(result);
      next.ready = [false, false, false, false];
      events.push({ type: 'round_scored', result });
      if (next.results.length >= ROUND_COUNT) {
        next.phase = 'TOURNAMENT_COMPLETE';
        events.push({ type: 'tournament_complete', winners: tournamentWinners(totals), totals });
      } else {
        next.phase = 'ROUND_RESULT';
      }
      return done();
    }
  }
}
