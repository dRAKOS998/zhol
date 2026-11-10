import { describe, expect, it } from 'vitest';
import {
  type GameState,
  applyAction,
  chooseBotMove,
  createGame,
  createSeededRng,
  gameWinners,
  modeOf,
  playersOf,
  previousSeat,
  roundCountOf,
  seatPlayer,
} from '../src/index.js';
import { LOSER_17, LOSER_6, LOSER_ZERO, STARTER_WIN, must, rigPlan, startGame } from './helpers.js';

const dealOf = (s: GameState) => s.deal!;

describe('game modes', () => {
  it('Zhol Klasik is the default, and states saved before modes read as Klasik', () => {
    expect(createGame().mode).toBe('klasik');
    const legacy = createGame();
    delete legacy.mode;
    expect(modeOf(legacy)).toBe('klasik');
    expect(roundCountOf({ ...legacy, players: [0, 1, 2] })).toBe(3);
  });

  it('Zhol i Shpejtë plays a single round at any table size', () => {
    const g = createGame({}, 'shpejte');
    expect(roundCountOf(g)).toBe(1);
    expect(roundCountOf({ ...g, players: [0, 1, 2, 3] })).toBe(1);
  });

  it('Zhol i Shpejtë: whoever closes wins at once, and nobody gets points', () => {
    const { state, ctx } = startGame([rigPlan([[...STARTER_WIN, 'y01a'], LOSER_17, LOSER_ZERO, LOSER_6])], createSeededRng(1), 'shpejte');
    const d = dealOf(state);
    const r = must(applyAction(state, d.starter, { type: 'declare_win', tileId: 'y01a', dealId: d.dealId, turnId: d.turnId }, ctx));
    const res = r.state.results[0]!;
    expect(r.state.phase).toBe('TOURNAMENT_COMPLETE');
    expect(res.winner).toBe(d.starter);
    expect(res.deltas).toEqual([0, 0, 0, 0]);
    expect(res.totals).toEqual([0, 0, 0, 0]);
    // hands are still revealed, with the loose tiles counted
    expect(res.penalties[(d.starter + 1) % 4]).toBe(17);
    expect(res.hands?.every(Boolean)).toBe(true);
    expect(gameWinners(r.state)).toEqual([d.starter]);
    expect(r.events.at(-1)).toMatchObject({ type: 'tournament_complete', winners: [d.starter] });
    expect(r.state.seriesWins![d.starter]).toBe(1);
  });

  it('Zhol i Shpejtë: closing with a Zhol still just wins', () => {
    const { state, ctx } = startGame([rigPlan([[...STARTER_WIN, 'z2']])], createSeededRng(1), 'shpejte');
    const d = dealOf(state);
    const r = must(applyAction(state, d.starter, { type: 'declare_win', tileId: 'z2', dealId: d.dealId, turnId: d.turnId }, ctx));
    expect(r.state.results[0]).toMatchObject({ finishType: 'zhol', winner: d.starter, deltas: [0, 0, 0, 0] });
    expect(r.state.phase).toBe('TOURNAMENT_COMPLETE');
  });

  it('Zhol i Shpejtë: a rematch is another single round in the same mode', () => {
    const { state, ctx } = startGame([rigPlan([[...STARTER_WIN, 'y01a']])], createSeededRng(1), 'shpejte');
    const d = dealOf(state);
    let s = must(applyAction(state, d.starter, { type: 'declare_win', tileId: 'y01a', dealId: d.dealId, turnId: d.turnId }, ctx)).state;
    for (const p of playersOf(s)) s = must(applyAction(s, p, { type: 'ready', ready: true }, ctx)).state;
    expect(s.mode).toBe('shpejte');
    expect(s.gameNumber).toBe(2);
    expect(s.results).toEqual([]);
    expect(s.phase).toBe('AWAITING_DISCARD');
    expect(roundCountOf(s)).toBe(1);
  });

  it.each([[[0, 1]], [[0, 2, 3]], [[0, 1, 2, 3]]])('bots finish a %j Zhol i Shpejtë game in one round', (seats) => {
    const rng = createSeededRng(seats.length * 7);
    const ctx = { rng };
    let s = createGame({}, 'shpejte');
    for (const n of seats) s = must(seatPlayer(s, n)).state;
    for (const n of seats.slice(1)) s = must(applyAction(s, n, { type: 'ready', ready: true }, ctx)).state;
    s = must(applyAction(s, seats[0]!, { type: 'start' }, ctx)).state;
    let turns = 0;
    while (s.phase !== 'TOURNAMENT_COMPLETE') {
      if (++turns > 20000) throw new Error('game did not finish');
      expect(s.phase).not.toBe('ROUND_RESULT');
      const deal = s.deal!;
      const me = deal.active;
      const move = chooseBotMove({
        phase: s.phase as 'AWAITING_DRAW' | 'AWAITING_DISCARD',
        rack: deal.racks[me]!.map((e) => e.id),
        previousDiscard: deal.discards[previousSeat(me, playersOf(s))]!.at(-1) ?? null,
      });
      const action =
        move.type === 'draw'
          ? { type: 'draw' as const, source: move.source, dealId: deal.dealId, turnId: deal.turnId }
          : { type: move.type, tileId: move.tileId, dealId: deal.dealId, turnId: deal.turnId };
      s = must(applyAction(s, me, action, ctx)).state;
    }
    expect(s.results).toHaveLength(1);
    expect(gameWinners(s)).toEqual([s.results[0]!.winner]);
  });
});
