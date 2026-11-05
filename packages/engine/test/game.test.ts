import { describe, expect, it } from 'vitest';
import {
  type GameState,
  OPENING_STOCK,
  applyAction,
  assertValidDealPlan,
  createRandomDealPlan,
  createSeededRng,
  createTileSet,
  isZhol,
  nextSeat,
  previousSeat,
  rackIds,
  tournamentWinners,
} from '../src/index.js';
import {
  FULL_A,
  FULL_C,
  LOSER_17,
  LOSER_6,
  LOSER_ZERO,
  STARTER_WIN,
  ids,
  must,
  rigPlan,
  startGame,
} from './helpers.js';

const dealOf = (s: GameState) => s.deal!;

describe('deal', () => {
  it('conserves 106 tiles with 57 on racks, 1 indicator, 48 stock', () => {
    const rng = createSeededRng(3);
    for (let i = 0; i < 50; i++) {
      const plan = createRandomDealPlan(rng);
      assertValidDealPlan(plan);
      expect(plan.racks.map((r) => r.length)).toEqual([15, 14, 14, 14]);
      expect(plan.racks.flat().length + 1 + plan.stock.length).toBe(106);
      expect(plan.stock).toHaveLength(OPENING_STOCK);
      expect(isZhol(plan.indicator)).toBe(false);
    }
    expect(createTileSet()).toHaveLength(106);
    expect(new Set(createTileSet()).size).toBe(106);
  });
  it('is deterministic for a seeded RNG', () => {
    expect(createRandomDealPlan(createSeededRng(5))).toEqual(createRandomDealPlan(createSeededRng(5)));
    expect(createRandomDealPlan(createSeededRng(5))).not.toEqual(createRandomDealPlan(createSeededRng(6)));
  });
  it('shuffles roughly uniformly (indicator position chi-square sanity)', () => {
    const rng = createSeededRng(11);
    const counts = new Map<string, number>();
    for (let i = 0; i < 20800; i++) {
      const id = createRandomDealPlan(rng).indicator;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.size).toBe(104);
    for (const c of counts.values()) expect(c).toBeGreaterThan(120);
  });
});

describe('lobby and turn order', () => {
  it('requires all four ready; the starter gets 15 tiles and must discard first', () => {
    const { state } = startGame();
    expect(state.phase).toBe('AWAITING_DISCARD');
    const d = dealOf(state);
    expect(d.active).toBe(d.starter);
    expect(d.racks[d.starter]).toHaveLength(15);
    for (let s = 0; s < 4; s++) if (s !== d.starter) expect(d.racks[s]).toHaveLength(14);
    expect(d.stock).toHaveLength(48);
    expect(state.roundNumber).toBe(1);
  });

  it('does not deal before all four are ready and repeated ready is harmless', () => {
    const { state: dealt } = startGame();
    void dealt;
    const ctx = { rng: createSeededRng(1) };
    let s = startGame().state;
    // fresh lobby
    s = { ...s, phase: 'LOBBY', deal: null, ready: [false, false, false, false], roundNumber: 0 };
    s = must(applyAction(s, 0, { type: 'ready', ready: true }, ctx)).state;
    s = must(applyAction(s, 0, { type: 'ready', ready: true }, ctx)).state;
    expect(s.phase).toBe('LOBBY');
    expect(s.ready).toEqual([true, false, false, false]);
  });

  it('plays clockwise with legal draw sources and rejects illegal ones', () => {
    const { state, ctx } = startGame();
    let s = state;
    const d = dealOf(s);
    const starter = d.starter;
    // starter cannot draw
    expect(applyAction(s, starter, { type: 'draw', source: 'stock', dealId: d.dealId, turnId: d.turnId }, ctx)).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    const firstDiscard = d.racks[starter]![0]!.id;
    s = must(applyAction(s, starter, { type: 'discard', tileId: firstDiscard, dealId: d.dealId, turnId: d.turnId }, ctx)).state;
    expect(s.phase).toBe('AWAITING_DRAW');
    const n1 = nextSeat(starter);
    expect(dealOf(s).active).toBe(n1);
    // others cannot act
    expect(applyAction(s, starter, { type: 'draw', source: 'stock', dealId: d.dealId, turnId: dealOf(s).turnId }, ctx)).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    // stale turn id
    expect(applyAction(s, n1, { type: 'draw', source: 'stock', dealId: d.dealId, turnId: d.turnId }, ctx)).toMatchObject({ ok: false, code: 'STALE_TURN' });
    // stale deal id
    expect(applyAction(s, n1, { type: 'draw', source: 'stock', dealId: 'd999', turnId: dealOf(s).turnId }, ctx)).toMatchObject({ ok: false, code: 'STALE_DEAL' });
    // discard before draw
    expect(applyAction(s, n1, { type: 'discard', tileId: dealOf(s).racks[n1]![0]!.id, dealId: d.dealId, turnId: dealOf(s).turnId }, ctx)).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    // take the previous player's discard
    s = must(applyAction(s, n1, { type: 'draw', source: 'previous_discard', dealId: d.dealId, turnId: dealOf(s).turnId }, ctx)).state;
    expect(rackIds(dealOf(s), n1)).toContain(firstDiscard);
    expect(dealOf(s).discards[starter]).toEqual([]);
    expect(dealOf(s).racks[n1]).toHaveLength(15);
    // discard a tile not owned
    expect(applyAction(s, n1, { type: 'discard', tileId: dealOf(s).racks[starter]![0]!.id, dealId: d.dealId, turnId: dealOf(s).turnId }, ctx)).toMatchObject({ ok: false, code: 'TILE_NOT_IN_RACK' });
    s = must(applyAction(s, n1, { type: 'discard', tileId: firstDiscard, dealId: d.dealId, turnId: dealOf(s).turnId }, ctx)).state;
    const n2 = nextSeat(n1);
    expect(dealOf(s).active).toBe(n2);
    expect(previousSeat(n2)).toBe(n1);
    // n2 draws stock; the stock shrinks by one
    const before = dealOf(s).stock.length;
    s = must(applyAction(s, n2, { type: 'draw', source: 'stock', dealId: d.dealId, turnId: dealOf(s).turnId }, ctx)).state;
    expect(dealOf(s).stock.length).toBe(before - 1);
    expect(dealOf(s).stock.length + 57 + 1 + dealOf(s).discards.flat().length).toBe(106);
  });

  it('rejects taking from an empty previous pile', () => {
    const { state, ctx } = startGame();
    const d = dealOf(state);
    let s = must(applyAction(state, d.starter, { type: 'discard', tileId: d.racks[d.starter]![0]!.id, dealId: d.dealId, turnId: 1 }, ctx)).state;
    const n1 = nextSeat(d.starter);
    s = must(applyAction(s, n1, { type: 'draw', source: 'stock', dealId: d.dealId, turnId: 2 }, ctx)).state;
    s = must(applyAction(s, n1, { type: 'discard', tileId: dealOf(s).racks[n1]![0]!.id, dealId: d.dealId, turnId: 3 }, ctx)).state;
    // n2's previous pile is n1's (non-empty); empty it artificially to test the guard.
    const n2 = nextSeat(n1);
    const hacked = structuredClone(s);
    hacked.deal!.stock.push(...hacked.deal!.discards[n1]!.splice(0));
    expect(applyAction(hacked, n2, { type: 'draw', source: 'previous_discard', dealId: d.dealId, turnId: 4 }, ctx)).toMatchObject({ ok: false, code: 'EMPTY_DISCARD' });
  });

  it('sorting is private, validates the permutation and never changes the turn id', () => {
    const { state, ctx } = startGame();
    const d = dealOf(state);
    const other = nextSeat(d.starter);
    const rack = d.racks[other]!;
    const reversed = rack.map((e, i) => ({ id: e.id, slot: 23 - i }));
    const s = must(applyAction(state, other, { type: 'sort', dealId: d.dealId, placements: reversed }, ctx)).state;
    expect(dealOf(s).turnId).toBe(d.turnId);
    expect(rackIds(dealOf(s), other)).toEqual(rack.map((e) => e.id).reverse());
    const dup = reversed.map((p, i) => (i === 1 ? { ...p, id: reversed[0]!.id } : p));
    expect(applyAction(state, other, { type: 'sort', dealId: d.dealId, placements: dup }, ctx)).toMatchObject({ code: 'INVALID_PERMUTATION' });
    expect(applyAction(state, other, { type: 'sort', dealId: d.dealId, placements: reversed.slice(1) }, ctx)).toMatchObject({ code: 'INVALID_PERMUTATION' });
    const foreign = reversed.map((p, i) => (i === 0 ? { ...p, id: d.racks[d.starter]![0]!.id } : p));
    expect(applyAction(state, other, { type: 'sort', dealId: d.dealId, placements: foreign }, ctx)).toMatchObject({ code: 'INVALID_PERMUTATION' });
    const sameSlot = reversed.map((p) => ({ ...p, slot: 3 }));
    expect(applyAction(state, other, { type: 'sort', dealId: d.dealId, placements: sameSlot }, ctx)).toMatchObject({ code: 'INVALID_PERMUTATION' });
    // the starter's pending discard is still valid after an opponent sorts
    expect(applyAction(s, d.starter, { type: 'discard', tileId: d.racks[d.starter]![0]!.id, dealId: d.dealId, turnId: d.turnId }, ctx).ok).toBe(true);
  });
});

/** Play until the stock is empty: everyone draws from stock and discards the drawn tile. */
function playOutStock(state: GameState, ctx: Parameters<typeof applyAction>[3]): GameState {
  let s = state;
  const d0 = dealOf(s);
  s = must(applyAction(s, d0.starter, { type: 'discard', tileId: 'y01a', dealId: d0.dealId, turnId: d0.turnId }, ctx)).state;
  for (;;) {
    const d = dealOf(s);
    const seat = d.active;
    s = must(applyAction(s, seat, { type: 'draw', source: 'stock', dealId: d.dealId, turnId: d.turnId }, ctx)).state;
    const after = dealOf(s);
    if (after.stock.length === 0) return s;
    const drawn = after.racks[seat]!.find((e) => !d.racks[seat]!.some((x) => x.id === e.id))!.id;
    s = must(applyAction(s, seat, { type: 'discard', tileId: drawn, dealId: d.dealId, turnId: after.turnId }, ctx)).state;
  }
}

describe('stock exhaustion', () => {
  const plan = () => rigPlan([[...STARTER_WIN, 'y01a']]);

  it('lets the player who drew the last tile close', () => {
    const { state, ctx } = startGame([plan()]);
    const s = playOutStock(state, ctx);
    const d = dealOf(s);
    expect(d.active).toBe(d.starter); // 48 draws: the 48th lands on the starter
    const drawn = d.racks[d.starter]!.find((e) => !STARTER_WIN.includes(e.id))!.id;
    const r = must(applyAction(s, d.starter, { type: 'declare_win', tileId: drawn, dealId: d.dealId, turnId: d.turnId }, ctx));
    expect(r.state.phase).toBe('ROUND_RESULT');
    expect(r.state.results).toHaveLength(1);
  });

  it('blocks the deal on an ordinary discard and redeals the same round with the same starter', () => {
    const { state, ctx } = startGame([plan()]);
    const s = playOutStock(state, ctx);
    const d = dealOf(s);
    const tile = d.racks[d.active]![0]!.id;
    const r = must(applyAction(s, d.active, { type: 'discard', tileId: tile, dealId: d.dealId, turnId: d.turnId }, ctx));
    const nd = dealOf(r.state);
    expect(nd.dealId).not.toBe(d.dealId);
    expect(nd.starter).toBe(d.starter);
    expect(nd.roundNumber).toBe(1);
    expect(r.state.roundNumber).toBe(1);
    expect(r.state.results).toEqual([]);
    expect(r.state.blockedDeals).toBe(1);
    expect(r.state.phase).toBe('AWAITING_DISCARD');
    expect(nd.racks[nd.starter]).toHaveLength(15);
    expect(nd.stock).toHaveLength(48);
    expect(r.events.some((e) => e.type === 'deal_blocked')).toBe(true);
    // a stale command for the blocked deal is rejected
    expect(applyAction(r.state, nd.starter, { type: 'discard', tileId: nd.racks[nd.starter]![0]!.id, dealId: d.dealId, turnId: nd.turnId }, ctx)).toMatchObject({ code: 'STALE_DEAL' });
  });
});

describe('closing and scoring', () => {
  it('an invalid close leaves everything unchanged', () => {
    const { state, ctx } = startGame([rigPlan([[...STARTER_WIN, 'y01a']])]);
    const d = dealOf(state);
    const snapshot = structuredClone(state);
    const r = applyAction(state, d.starter, { type: 'declare_win', tileId: 'r12a', dealId: d.dealId, turnId: d.turnId }, ctx);
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CLOSE', details: { reason: 'NOT_FULL_COVER' } });
    expect(state).toEqual(snapshot);
  });

  it('an ordinary discard never closes automatically', () => {
    const { state, ctx } = startGame([rigPlan([[...STARTER_WIN, 'y01a']])]);
    const d = dealOf(state);
    const r = must(applyAction(state, d.starter, { type: 'discard', tileId: 'y01a', dealId: d.dealId, turnId: d.turnId }, ctx));
    expect(r.state.phase).toBe('AWAITING_DRAW');
    expect(r.state.results).toEqual([]);
  });

  it('ordinary close: winner −20; losers +17, 0 and +6 (Zhol stands in for Red 5)', () => {
    const { state, ctx } = startGame([rigPlan([[...STARTER_WIN, 'y01a'], LOSER_17, LOSER_ZERO, LOSER_6])]);
    const d = dealOf(state);
    const r = must(applyAction(state, d.starter, { type: 'declare_win', tileId: 'y01a', dealId: d.dealId, turnId: d.turnId }, ctx));
    const res = r.state.results[0]!;
    const s = d.starter;
    expect(res.finishType).toBe('normal');
    expect(res.deltas[s]).toBe(-20);
    expect(res.deltas[(s + 1) % 4]).toBe(17);
    expect(res.deltas[(s + 2) % 4]).toBe(0);
    expect(res.deltas[(s + 3) % 4]).toBe(6);
    expect(res.totals).toEqual(res.deltas);
    expect(r.state.phase).toBe('ROUND_RESULT');
    expect(r.state.ready).toEqual([false, false, false, false]);
    // no further gameplay in ROUND_RESULT
    expect(applyAction(r.state, s, { type: 'declare_win', tileId: 'r01a', dealId: d.dealId, turnId: dealOf(r.state).turnId }, ctx)).toMatchObject({ code: 'WRONG_PHASE' });
  });

  it('discarding a Zhol to close scores −40', () => {
    const { state, ctx } = startGame([rigPlan([[...STARTER_WIN, 'z2']])]);
    const d = dealOf(state);
    const r = must(applyAction(state, d.starter, { type: 'declare_win', tileId: 'z2', dealId: d.dealId, turnId: d.turnId }, ctx));
    expect(r.state.results[0]).toMatchObject({ finishType: 'zhol', winner: d.starter });
    expect(r.state.results[0]!.deltas[d.starter]).toBe(-40);
  });

  it('a Zhol used inside the winning hand earns no bonus', () => {
    const hand = ids('r01a r02a z1 r04a u05a u06a u07a k09a k10a k11a r12a u12a k12a y12a');
    const { state, ctx } = startGame([rigPlan([[...hand, 'y01a']])]);
    const d = dealOf(state);
    const r = must(applyAction(state, d.starter, { type: 'declare_win', tileId: 'y01a', dealId: d.dealId, turnId: d.turnId }, ctx));
    expect(r.state.results[0]).toMatchObject({ finishType: 'normal' });
    expect(r.state.results[0]!.deltas[d.starter]).toBe(-20);
  });
});

describe('tournament', () => {
  const quickWin = () => rigPlan([[...STARTER_WIN, 'y01a'], FULL_A, LOSER_ZERO, FULL_C]);

  function playFour(plans = [quickWin(), quickWin(), quickWin(), quickWin()]) {
    let { state: s, ctx } = startGame(plans.slice(0, 1));
    const queue = plans.slice(1);
    ctx = { ...ctx, takeDealPlan: () => queue.shift() };
    const starters: number[] = [];
    for (let round = 1; round <= 4; round++) {
      const d = dealOf(s);
      starters.push(d.starter);
      expect(s.roundNumber).toBe(round);
      s = must(applyAction(s, d.starter, { type: 'declare_win', tileId: 'y01a', dealId: d.dealId, turnId: d.turnId }, ctx)).state;
      if (round < 4) {
        expect(s.phase).toBe('ROUND_RESULT');
        for (let i = 0; i < 4; i++) {
          s = must(applyAction(s, i, { type: 'ready', ready: true }, ctx)).state;
          if (i < 3) expect(s.phase).toBe('ROUND_RESULT');
        }
      }
    }
    return { s, ctx, starters };
  }

  it('rotates the starter so each seat starts once, then completes', () => {
    const { s, starters, ctx } = playFour();
    expect(new Set(starters).size).toBe(4);
    for (let i = 1; i < 4; i++) expect(starters[i]).toBe((starters[0]! + i) % 4);
    expect(s.phase).toBe('TOURNAMENT_COMPLETE');
    expect(s.results).toHaveLength(4);
    // everyone won once with all-zero losers: four-way tie at −20
    expect(s.results[3]!.totals).toEqual([-20, -20, -20, -20]);
    expect(tournamentWinners(s.results[3]!.totals)).toEqual([0, 1, 2, 3]);
    // no fifth round
    expect(applyAction(s, 0, { type: 'ready', ready: true }, ctx)).toMatchObject({ code: 'TOURNAMENT_COMPLETE' });
  });

  it('reports a single winner or joint winners', () => {
    expect(tournamentWinners([-40, 3, 10, 0])).toEqual([0]);
    expect(tournamentWinners([5, -3, -3, 12])).toEqual([1, 2]);
  });
});
