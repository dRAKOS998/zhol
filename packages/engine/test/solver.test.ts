import { describe, expect, it } from 'vitest';
import {
  type TileId,
  checkClose,
  createSeededRng,
  createTileSet,
  evaluateHand,
  isLegalLink,
  shuffleInPlace,
  tilePenalty,
} from '../src/index.js';
import { ids } from './helpers.js';

/** Exhaustive reference: try every subset containing the first tile, using the independent validator. */
function referencePenalty(hand: TileId[], zholPenalty = 20): number {
  const memo = new Map<string, number>();
  const go = (rest: TileId[]): number => {
    if (rest.length === 0) return 0;
    const key = rest.join(',');
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const [first, ...others] = rest as [TileId, ...TileId[]];
    let best = tilePenalty(first, { zholPenalty }) + go(others);
    const k = others.length;
    for (let m = 1; m < 1 << k; m++) {
      const pick = others.filter((_, i) => m & (1 << i));
      if (pick.length < 2) continue;
      if (!isLegalLink([first, ...pick])) continue;
      best = Math.min(best, go(others.filter((_, i) => !(m & (1 << i)))));
    }
    memo.set(key, best);
    return best;
  };
  return go([...hand].sort());
}

function assertConsistent(hand: TileId[], zholPenalty = 20) {
  const ev = evaluateHand(hand, { zholPenalty });
  const used = [...ev.links.flatMap((l) => l.slots.map((s) => s.id)), ...ev.unlinked];
  expect(used.sort()).toEqual([...hand].sort());
  for (const link of ev.links) expect(isLegalLink(link.slots.map((s) => s.id))).toBe(true);
  expect(ev.penalty).toBe(ev.unlinked.reduce((a, id) => a + tilePenalty(id, { zholPenalty }), 0));
  expect(ev.fullCover).toBe(ev.unlinked.length === 0);
  return ev;
}

describe('legal links', () => {
  it('accepts runs of one color including Blue 1–2–3–4', () => {
    expect(isLegalLink(ids('u01a u02a u03a u04a'))).toBe(true);
    expect(evaluateHand(ids('u01a u02a u03a u04a')).fullCover).toBe(true);
  });
  it('rejects wraparound 12–13–1', () => {
    expect(isLegalLink(ids('r12a r13a r01a'))).toBe(false);
    expect(evaluateHand(ids('r12a r13a r01a')).penalty).toBe(26);
  });
  it('rejects mixed colors in a run and runs shorter than 3', () => {
    expect(isLegalLink(ids('r04a u05a r06a'))).toBe(false);
    expect(isLegalLink(ids('r04a r05a'))).toBe(false);
  });
  it('accepts a 13-tile run and nothing longer', () => {
    const run = Array.from({ length: 13 }, (_, i) => `y${String(i + 1).padStart(2, '0')}a`);
    expect(isLegalLink(run)).toBe(true);
    expect(evaluateHand(run).fullCover).toBe(true);
  });
  it('accepts sets of 3 and 4 distinct colors', () => {
    expect(isLegalLink(ids('r07a u07a k07a'))).toBe(true);
    expect(isLegalLink(ids('r07a u07a k07a y07b'))).toBe(true);
  });
  it('rejects two copies of the same color in a set', () => {
    expect(isLegalLink(ids('r07a r07b u07a'))).toBe(false);
    const ev = assertConsistent(ids('r07a r07b u07a'));
    expect(ev.penalty).toBe(21);
  });
  it('uses each duplicate copy at most once', () => {
    const ev = assertConsistent(ids('r05a r05b r06a r07a'));
    expect(ev.penalty).toBe(5);
    expect(ev.unlinked).toHaveLength(1);
  });
});

describe('wildcards', () => {
  it('fills a gap inside a run and records the assignment', () => {
    const ev = assertConsistent(ids('r05a r07a z1'));
    expect(ev.fullCover).toBe(true);
    const z = ev.links[0]!.slots.find((s) => s.id === 'z1')!;
    expect(z).toMatchObject({ wildcard: true, color: 'red', rank: 6 });
  });
  it('lets two Zhols fill two distinct positions', () => {
    expect(assertConsistent(ids('r05a z1 z2')).fullCover).toBe(true);
    expect(assertConsistent(ids('k03a k06a z1 z2')).fullCover).toBe(true);
    expect(assertConsistent(ids('k03a k07a z1 z2')).fullCover).toBe(false);
  });
  it('fills a missing color in a set', () => {
    const ev = assertConsistent(ids('r09a u09a z2'));
    expect(ev.fullCover).toBe(true);
    expect(ev.links[0]!.kind).toBe('set');
  });
  it('charges 20 for an unlinked Zhol by default and honours the configured value', () => {
    expect(evaluateHand(['z1']).penalty).toBe(20);
    expect(evaluateHand(['z1'], { zholPenalty: 30 }).penalty).toBe(30);
    expect(evaluateHand(ids('z1 r01a k13a')).penalty).toBe(34);
  });
  it('treats the indicator tile as an ordinary numbered tile (only z1/z2 are wild)', () => {
    expect(evaluateHand(ids('r05a k09a u02a')).fullCover).toBe(false);
  });
});

describe('optimal grouping', () => {
  it('beats greedy: Red 4–5–6–7 + Blue 7 + Black 7 scores zero', () => {
    const ev = assertConsistent(ids('r04a r05a r06a r07a u07a k07a'));
    expect(ev.penalty).toBe(0);
    expect(ev.fullCover).toBe(true);
    const kinds = ev.links.map((l) => l.kind).sort();
    expect(kinds).toEqual(['run', 'set']);
  });
  it('handles overlapping candidates', () => {
    const ev = assertConsistent(ids('r05a r06a r07a r08a u06a k06a y06a u07a k07a'));
    expect(ev.penalty).toBe(referencePenalty(ids('r05a r06a r07a r08a u06a k06a y06a u07a k07a')));
  });
  it('the +17 example: unlinked Red 5 and Black 12', () => {
    const ev = assertConsistent(ids('r01b r02b r03b u08b u09b u10b y07b y08b y09b k05b k06b k07b r05b k12b'));
    expect(ev.penalty).toBe(17);
    expect(ev.unlinked.sort()).toEqual(['k12b', 'r05b']);
  });
  it('is independent of rack order and deterministic', () => {
    const hand = ids('r04a r05a r06a r07a u07a k07a z1 y02a y03a k12a k11b u01a');
    const base = evaluateHand(hand);
    const rng = createSeededRng(7);
    for (let i = 0; i < 25; i++) {
      const shuffled = shuffleInPlace([...hand], rng);
      expect(evaluateHand(shuffled)).toEqual(base);
    }
  });
  it('matches the exhaustive reference on 600 random small hands', () => {
    const rng = createSeededRng(2026);
    // A dense pool (few ranks, three colors, both Zhols) makes overlaps likely.
    const pool = createTileSet().filter((id) => id.startsWith('z') || (/^[rku]0[3-8]/.test(id)));
    for (let i = 0; i < 600; i++) {
      const size = 3 + rng.int(7); // 3..9 tiles
      const hand = shuffleInPlace([...pool], rng).slice(0, size);
      const ev = assertConsistent(hand);
      expect(ev.penalty, hand.join(' ')).toBe(referencePenalty(hand));
    }
  });
  it('solves random 14-tile hands quickly and consistently', () => {
    const rng = createSeededRng(99);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) assertConsistent(shuffleInPlace(createTileSet(), rng).slice(0, 14));
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
  it('solves a pathological dense 15-tile hand', () => {
    const hand = ids('r03a r03b r04a r04b r05a r05b r06a r06b r07a r07b r08a r08b r09a z1 z2');
    const ev = assertConsistent(hand);
    expect(ev.fullCover).toBe(true);
  });
});

describe('close validation', () => {
  const win = ids('r01a r02a r03a r04a u05a u06a u07a k09a k10a k11a r12a u12a k12a y12a');
  it('requires a 15-tile rack and a tile from it', () => {
    expect(checkClose(win, 'r01a').reason).toBe('RACK_SIZE');
    expect(checkClose([...win, 'y01a'], 'k13b').reason).toBe('TILE_NOT_IN_RACK');
  });
  it('accepts a full cover after the discard', () => {
    expect(checkClose([...win, 'y01a'], 'y01a').valid).toBe(true);
  });
  it('rejects when the remaining 14 tiles are not all linked', () => {
    const r = checkClose([...win, 'y01a'], 'r12a');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('NOT_FULL_COVER');
  });
  it('does not recognise seven pairs', () => {
    const pairs = ids('r01a r01b u03a u03b k05a k05b y07a y07b r09a r09b u11a u11b k13a k13b y02a');
    expect(checkClose(pairs, 'y02a').valid).toBe(false);
  });
});
