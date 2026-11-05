import { describe, expect, it } from 'vitest';
import {
  type GameState,
  applyAction,
  assertValidDealPlan,
  chooseBotMove,
  createGame,
  createRandomDealPlan,
  createSeededRng,
  openingStockFor,
  playersOf,
  previousSeat,
  seatPlayer,
  unseatPlayer,
} from '../src/index.js';

function seat(state: GameState, seats: number[]): GameState {
  let s = state;
  for (const n of seats) {
    const r = seatPlayer(s, n);
    if (!r.ok) throw new Error(r.code);
    s = r.state;
  }
  return s;
}

/** Drive a whole tournament with bots in every seat. Returns the final state. */
function playOut(seats: number[], seed: number): { state: GameState; turns: number } {
  const rng = createSeededRng(seed);
  const ctx = { rng };
  let s = seat(createGame(), seats);
  for (const n of seats.slice(1)) {
    const r = applyAction(s, n, { type: 'ready', ready: true }, ctx);
    if (!r.ok) throw new Error(r.code);
    s = r.state;
  }
  const started = applyAction(s, seats[0]!, { type: 'start' }, ctx);
  if (!started.ok) throw new Error(started.code);
  s = started.state;
  let turns = 0;
  while (s.phase !== 'TOURNAMENT_COMPLETE') {
    if (++turns > 20000) throw new Error('tournament did not finish');
    if (s.phase === 'ROUND_RESULT') {
      for (const p of playersOf(s)) {
        const r = applyAction(s, p, { type: 'ready', ready: true }, ctx);
        if (!r.ok) throw new Error(r.code);
        s = r.state;
      }
      continue;
    }
    const deal = s.deal!;
    const me = deal.active;
    const prev = previousSeat(me, playersOf(s));
    const move = chooseBotMove({
      phase: s.phase as 'AWAITING_DRAW' | 'AWAITING_DISCARD',
      rack: deal.racks[me]!.map((e) => e.id),
      previousDiscard: deal.discards[prev]!.at(-1) ?? null,
    });
    const action =
      move.type === 'draw'
        ? { type: 'draw' as const, source: move.source, dealId: deal.dealId, turnId: deal.turnId }
        : { type: move.type, tileId: move.tileId, dealId: deal.dealId, turnId: deal.turnId };
    const r = applyAction(s, me, action, ctx);
    if (!r.ok) throw new Error(`${r.code} on ${JSON.stringify(move)}`);
    s = r.state;
  }
  return { state: s, turns };
}

describe('2–4 players', () => {
  it('deals 15/14/… and keeps 106 tiles for every table size', () => {
    for (const n of [2, 3, 4]) {
      const plan = createRandomDealPlan(createSeededRng(n), n);
      expect(plan.racks).toHaveLength(n);
      expect(plan.stock).toHaveLength(openingStockFor(n));
      expect(() => assertValidDealPlan(plan)).not.toThrow();
    }
    expect(openingStockFor(2)).toBe(76);
    expect(openingStockFor(3)).toBe(62);
    expect(openingStockFor(4)).toBe(48);
  });

  it('a lone player cannot start; two can, once both are ready', () => {
    const ctx = { rng: createSeededRng(1) };
    let s = seat(createGame(), [0]);
    const alone = applyAction(s, 0, { type: 'start' }, ctx);
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.code).toBe('NOT_ENOUGH_PLAYERS');
    s = seat(s, [2]);
    const early = applyAction(s, 0, { type: 'start' }, ctx);
    expect(!early.ok && early.code).toBe('NOT_ALL_READY');
    const ready = applyAction(s, 2, { type: 'ready', ready: true }, ctx);
    if (!ready.ok) throw new Error(ready.code);
    // Two ready players do not auto-start: the host decides when.
    expect(ready.state.phase).toBe('LOBBY');
    const go = applyAction(ready.state, 0, { type: 'start' }, ctx);
    if (!go.ok) throw new Error(go.code);
    expect(go.state.players).toEqual([0, 2]);
    expect(go.state.deal!.racks[1]).toHaveLength(0);
    expect(go.state.deal!.stock).toHaveLength(76);
    expect(go.state.deal!.racks[go.state.deal!.starter]).toHaveLength(15);
  });

  it('a full table still starts by itself when all four are ready', () => {
    const ctx = { rng: createSeededRng(3) };
    let s = seat(createGame(), [0, 1, 2, 3]);
    for (const n of [0, 1, 2, 3]) {
      const r = applyAction(s, n, { type: 'ready', ready: true }, ctx);
      if (!r.ok) throw new Error(r.code);
      s = r.state;
    }
    expect(s.phase).toBe('AWAITING_DISCARD');
    expect(s.players).toEqual([0, 1, 2, 3]);
  });

  it('unseats a lobby seat', () => {
    const s = seat(createGame(), [0, 1]);
    const r = unseatPlayer(s, 1);
    expect(r.ok && r.state.seated).toEqual([true, false, false, false]);
  });

  for (const seats of [
    [0, 1],
    [0, 2, 3],
    [0, 1, 2, 3],
  ]) {
    it(`bots finish a ${seats.length}-player tournament with one round per player`, () => {
      for (const seed of [11, 12]) {
        const { state } = playOut(seats, seed);
        expect(state.results).toHaveLength(seats.length);
        const starters = state.results.map((r) => r.winner);
        expect(starters.every((w) => seats.includes(w))).toBe(true);
        const last = state.results.at(-1)!;
        // Seats outside the tournament never score.
        for (let s = 0; s < 4; s++) if (!seats.includes(s)) expect(last.totals[s]).toBe(0);
      }
    });
  }
});
