import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { type DealPlan, createSeededRng, createTileSet, isZhol } from '@zhol/engine';
import { FULL_A, STARTER_WIN } from '../../../packages/engine/test/helpers.js';
import type { PlayerView } from '@zhol/protocol';
import { createZholServer, type ZholServer, type ZholServerOptions } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { Player, bySeat, rid, sleep, tempDbPath, testConfig } from './harness.js';

let servers: ZholServer[] = [];
let clients: Player[] = [];
afterEach(async () => {
  clients.forEach((c) => c.close());
  clients = [];
  for (const s of servers) await s.close().catch(() => {});
  servers = [];
});

const FAST = { ready: [5, 10], draw: [5, 10], discard: [5, 10] } as NonNullable<ZholServerOptions['botDelayMs']>;
const turnArgs = (v: PlayerView) => ({ dealId: v.state.dealId!, turnId: v.state.turnId! });

async function start(autoplayMs: ZholServerOptions['autoplayMs'], dbPath = tempDbPath()) {
  const server = createZholServer({ config: testConfig(dbPath), rng: createSeededRng(11), botDelayMs: FAST, autoplayMs });
  servers.push(server);
  const url = `http://127.0.0.1:${await server.listen(0)}`;
  return { server, url, dbPath };
}

async function player(url: string) {
  const p = new Player(url);
  clients.push(p);
  await p.connected();
  return p;
}

/** Two humans at a started two-player table. */
async function duo(autoplayMs: ZholServerOptions['autoplayMs']) {
  const s = await start(autoplayMs);
  const a = await player(s.url);
  const { code } = await a.create('Arta');
  const b = await player(s.url);
  await b.join(code, 'Besi');
  await b.call('player_ready', { requestId: rid(), ready: true });
  expect((await a.call('start_game', { requestId: rid() })).ok).toBe(true);
  await Promise.all([a, b].map((p) => p.until((v) => v.state.phase === 'AWAITING_DISCARD')));
  return { ...s, a, b, code, players: [a, b] };
}

describe('players who are away', () => {
  it('plays for a disconnected player after the wait, and hands the seat back when they return', async () => {
    const { a, b, players, url, code } = await duo({ awayMs: 150, fastMs: 20 });
    const starter = bySeat(players, a.state.starter!);
    const other = starter === a ? b : a;
    const before = other.state.turnId!;
    starter.close();
    // The computer discards for the starter, so the turn reaches the player still at the table.
    const v = await other.until((x) => x.state.activeSeat === other.seat && x.state.phase === 'AWAITING_DRAW');
    expect(v.state.turnId).toBe(before + 1);
    expect(v.state.seats[starter.seat!]).toMatchObject({ connected: false, away: true, rackCount: 14, discardCount: 1 });
    // The player at the table has no limit here (turnMs is off): nothing moves without them.
    await sleep(250);
    expect(other.state.turnId).toBe(before + 1);
    expect(other.state.turnEndsInMs).toBeNull();

    const back = await player(url);
    expect((await back.join(code, undefined, starter.token!)).ok).toBe(true);
    const seen = await other.until((x) => x.state.seats[starter.seat!]!.connected);
    expect(seen.state.seats[starter.seat!]!.away).toBe(false);
  });

  it('waits for a player who reconnects in time', async () => {
    const { a, b, players, url, code } = await duo({ awayMs: 400, fastMs: 20 });
    const starter = bySeat(players, a.state.starter!);
    const other = starter === a ? b : a;
    const turn = other.state.turnId!;
    starter.close();
    await sleep(100);
    const back = await player(url);
    expect((await back.join(code, undefined, starter.token!)).ok).toBe(true);
    await sleep(500);
    expect(other.state.turnId).toBe(turn);
    expect(other.state.seats[starter.seat!]).toMatchObject({ connected: true, away: false, rackCount: 15 });
  });

  it('moves for a connected player who runs out of time, until they say they are back', async () => {
    const { a, b, players } = await duo({ turnMs: 150, fastMs: 30 });
    const starter = bySeat(players, a.state.starter!);
    const other = starter === a ? b : a;
    expect(starter.state.turnEndsInMs).toBeGreaterThan(0);
    expect(starter.state.turnEndsInMs).toBeLessThanOrEqual(150);
    // Nobody touches anything: the computer plays both seats, turn after turn.
    const v = await other.until((x) => x.state.turnId! >= 6);
    expect(v.state.seats.filter((s) => s.away).map((s) => s.seat).sort()).toEqual([0, 1]);

    expect((await starter.call('player_back', { requestId: rid() })).ok).toBe(true);
    const mine = await starter.until((x) => x.state.seats[starter.seat!]!.away === false);
    expect(mine.state.seats[other.seat!]!.away).toBe(true);
    // Any command of their own takes the seat back too, even one the game refuses.
    expect((await other.call('player_ready', { requestId: rid(), ready: true })).ok).toBe(false);
    await other.until((x) => x.state.seats[other.seat!]!.away === false);
  });

  it('leaves the table alone while nobody is there', async () => {
    const { a, b, server, code } = await duo({ awayMs: 60, turnMs: 60, fastMs: 10 });
    const turn = a.state.turnId!;
    a.close();
    b.close();
    await sleep(300);
    const room = server.rooms.get(code)!;
    expect(room.game.deal!.turnId).toBe(turn);
    expect(room.game.phase).toBe('AWAITING_DISCARD');
  });

  it('readies an away player for the next round', async () => {
    const s = await start({ awayMs: 120, fastMs: 20 });
    const a = await player(s.url);
    const { code } = await a.create('Arta');
    const b = await player(s.url);
    await b.join(code, 'Besi');
    s.server.testApi!.queueDealPlan(code, quickDuoPlan());
    await b.call('player_ready', { requestId: rid(), ready: true });
    await a.call('start_game', { requestId: rid() });
    await a.until((v) => v.state.phase === 'AWAITING_DISCARD');
    const starter = bySeat([a, b], a.state.starter!);
    const other = starter === a ? b : a;
    other.close();
    expect((await starter.call('declare_win', { requestId: rid(), ...turnArgs(starter.view!), tileId: 'y01a' })).ok).toBe(true);
    await starter.until((x) => x.state.phase === 'ROUND_RESULT');
    expect((await starter.call('player_ready', { requestId: rid(), ready: true })).ok).toBe(true);
    // The player who left is readied by the computer, which then plays their turns in round 2.
    const next = await starter.until((x) => x.state.roundNumber === 2 && x.state.activeSeat === starter.seat);
    expect(next.state.results).toHaveLength(1);
    expect(next.state.seats[other.seat!]).toMatchObject({ connected: false, away: true });
  });
});

/** A two-player deal the starter can close at once by discarding y01a. */
function quickDuoPlan(): DealPlan {
  const starter = [...STARTER_WIN, 'y01a'];
  const used = new Set([...starter, ...FULL_A]);
  const pool = createTileSet().filter((id) => !used.has(id));
  const indicator = pool.splice(pool.findIndex((id) => !isZhol(id)), 1)[0]!;
  return { indicator, racks: [starter, FULL_A], stock: pool };
}

describe('rematch', () => {
  it('a human asks, the bot agrees, and a new tournament starts in the same room', async () => {
    const { server, url } = await start(undefined);
    const p = await player(url);
    const { code } = await p.create('Arta');
    await p.call('add_bot', { requestId: rid() });
    await p.until((x) => x.state.seats[1]!.bot);
    for (let i = 0; i < 4; i++) server.testApi!.queueDealPlan(code, quickDuoPlan());
    expect((await p.call('start_game', { requestId: rid() })).ok).toBe(true);

    /** Whoever starts closes at once; ready up between rounds until the tournament is over. */
    const playOut = async () => {
      for (let round = 0; round < 2; round++) {
        const v = await p.until((x) => (x.state.phase === 'AWAITING_DISCARD' && x.state.activeSeat === 0) || x.state.results.length > round);
        if (v.state.results.length === round) {
          expect((await p.call('declare_win', { requestId: rid(), ...turnArgs(v), tileId: 'y01a' })).ok).toBe(true);
        }
        const scored = await p.until((x) => x.state.results.length > round);
        if (scored.state.phase === 'ROUND_RESULT') expect((await p.call('player_ready', { requestId: rid(), ready: true })).ok).toBe(true);
      }
      return p.until((x) => x.state.phase === 'TOURNAMENT_COMPLETE');
    };
    const done = (await playOut()).state;
    expect(done.results).toHaveLength(2);
    expect(done.totals.slice(0, 2)).toEqual([-20, -20]);
    expect(done).toMatchObject({ gameNumber: 1, seriesWins: [1, 1, 0, 0], winners: [0, 1] });
    for (const r of done.results) {
      expect(r.hands!.filter(Boolean)).toHaveLength(2);
      expect(r.hands![r.winner]).toMatchObject({ unlinked: [] });
    }
    // Bots do not start a rematch by themselves.
    await sleep(80);
    expect(p.state.phase).toBe('TOURNAMENT_COMPLETE');
    expect(p.state.seats[1]!.ready).toBe(false);

    expect((await p.call('player_ready', { requestId: rid(), ready: true })).ok).toBe(true);
    const again = await p.until((x) => x.state.gameNumber === 2);
    expect(again.state).toMatchObject({ roundNumber: 1, results: [], totals: [0, 0, 0, 0], winners: null, seriesWins: [1, 1, 0, 0] });
    expect(again.state.seats.map((x) => x.ready)).toEqual([false, false, false, false]);

    // The second tournament's rounds are added to the ledger next to the first's.
    const second = (await playOut()).state;
    expect(second).toMatchObject({ gameNumber: 2, seriesWins: [2, 2, 0, 0] });
    expect(server.db.results(code)).toHaveLength(4);
    expect(server.db.raw.prepare('SELECT game_number AS g, round_number AS r FROM round_results ORDER BY g, r').all()).toEqual([
      { g: 1, r: 1 },
      { g: 1, r: 2 },
      { g: 2, r: 1 },
      { g: 2, r: 2 },
    ]);
  });
});

describe('database', () => {
  it('migrates a ledger written before rematches, keeping its rows as game 1', () => {
    const file = tempDbPath();
    const old = new Database(file);
    old.exec(`
      CREATE TABLE rooms (code TEXT PRIMARY KEY, version INTEGER NOT NULL, names_json TEXT NOT NULL, state_json TEXT NOT NULL, phase TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, bots_json TEXT NOT NULL DEFAULT '[false,false,false,false]');
      CREATE TABLE round_results (
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 4),
        deal_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (room_code, round_number));
      CREATE TRIGGER round_results_immutable BEFORE UPDATE ON round_results
        BEGIN SELECT RAISE(ABORT, 'round results are immutable'); END;
      INSERT INTO rooms VALUES ('ABCD2345', 1, '[]', '{}', 'ROUND_RESULT', 1, 1, '[false,false,false,false]');
      INSERT INTO round_results VALUES ('ABCD2345', 1, 'd1', '{"roundNumber":1}', 5);
      INSERT INTO round_results VALUES ('ABCD2345', 2, 'd2', '{"roundNumber":2}', 6);
    `);
    old.close();

    const db = openDatabase(file);
    expect(db.results('ABCD2345')).toEqual([{ roundNumber: 1 }, { roundNumber: 2 }]);
    expect(db.raw.prepare('SELECT game_number, created_at FROM round_results ORDER BY round_number').all()).toEqual([
      { game_number: 1, created_at: 5 },
      { game_number: 1, created_at: 6 },
    ]);
    // A rematch can score round 1 again; the same round of the same game still cannot be scored twice.
    db.insertResult('ABCD2345', 2, { roundNumber: 1, dealId: 'd9' } as never);
    expect(() => db.insertResult('ABCD2345', 2, { roundNumber: 1, dealId: 'd9' } as never)).toThrow();
    expect(() => db.raw.prepare("UPDATE round_results SET deal_id = 'x'").run()).toThrow(/immutable/);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'round_results_v1'").all()).toEqual([]);
    db.close();
    // Opening it again changes nothing.
    const again = openDatabase(file);
    expect(again.results('ABCD2345')).toHaveLength(3);
    again.close();
  });
});
