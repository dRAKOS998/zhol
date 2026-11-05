import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerView } from '@zhol/protocol';
import { FULL_A, FULL_C, LOSER_17, LOSER_ZERO, STARTER_WIN, rigPlan } from '../../../packages/engine/test/helpers.js';
import { ORIGIN, Player, bySeat, fourPlayers, readyAll, rid, sleep, startServer, sync, tempDbPath, type ZholServer } from './harness.js';

const TILE_RE = /\b(?:[rkuy](?:0[1-9]|1[0-3])[ab]|z[12])\b/g;

let servers: ZholServer[] = [];
let clients: Player[] = [];
afterEach(async () => {
  clients.forEach((c) => c.close());
  clients = [];
  for (const s of servers) await s.close().catch(() => {});
  servers = [];
});

async function setup(seed = 42, dbPath = tempDbPath()) {
  const s = await startServer(dbPath, seed);
  servers.push(s.server);
  return s;
}

async function table(seed = 42) {
  const s = await setup(seed);
  const { players, code } = await fourPlayers(s.url);
  clients.push(...players);
  return { ...s, players, code };
}

const turnArgs = (v: PlayerView) => ({ dealId: v.state.dealId!, turnId: v.state.turnId! });

describe('rooms and seating', () => {
  it('can serve the web app with an SPA fallback for invite links', async () => {
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'zhol-web-'));
    (await import('node:fs')).writeFileSync(`${dir}/index.html`, '<!doctype html><title>Zhol</title>');
    const s = await startServer(tempDbPath(), 1, { webDistDir: dir });
    servers.push(s.server);
    const res = await fetch(`${s.url}/room/ABCD2345`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Zhol</title>');
    expect((await fetch(`${s.url}/health`)).headers.get('content-type')).toContain('json');
  });

  it('serves /health', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('creates a room with an unpredictable code and a shareable invite path', async () => {
    const { url } = await setup();
    const p = new Player(url);
    clients.push(p);
    await p.connected();
    const ack = await p.call<{ code: string; invitePath: string; inviteUrl: string; sessionToken: string }>('create_room', { requestId: rid(), nickname: '  Arta  ' });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.data.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(ack.data.invitePath).toBe(`/room/${ack.data.code}`);
    expect(ack.data.inviteUrl).toBe(`${ORIGIN}/room/${ack.data.code}`);
    expect(ack.data.invitePath).not.toContain(ack.data.sessionToken);
    const view = await p.until((v) => v.state.seats[0]!.name === 'Arta');
    expect(JSON.stringify(view)).not.toContain(ack.data.sessionToken);
  });

  it('validates payloads and reports actionable errors', async () => {
    const { url } = await setup();
    const p = new Player(url);
    clients.push(p);
    await p.connected();
    expect(await p.call('create_room', { requestId: rid(), nickname: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(await p.call('create_room', { requestId: rid(), nickname: '<script>' })).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(await p.call('create_room', { requestId: 'x', nickname: 'Ok' })).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(await p.call('create_room', { requestId: rid(), nickname: 'Ok', extra: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(await p.call('join_room', { requestId: rid(), code: 'ABCDEFGH', nickname: 'Ok' })).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
    expect(await p.call('draw_tile', { requestId: rid(), dealId: 'd1', turnId: 1, source: 'stock' })).toMatchObject({ ok: false, error: { code: 'NOT_IN_ROOM' } });
  });

  it('rejects disallowed origins', async () => {
    const { url } = await setup();
    const p = new Player(url, 'https://evil.example');
    clients.push(p);
    await expect(p.connected()).rejects.toBeTruthy();
  });

  it('seats four, rejects a fifth, duplicate names, and midgame newcomers', async () => {
    const { url, players, code } = await table();
    expect(players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
    const fifth = new Player(url);
    clients.push(fifth);
    await fifth.connected();
    expect(await fifth.join(code, 'Erion')).toMatchObject({ ok: false, error: { code: 'ROOM_FULL' } });
    await readyAll(players);
    expect(await fifth.join(code, 'Erion')).toMatchObject({ ok: false, error: { code: 'GAME_IN_PROGRESS' } });
    expect(await fifth.join(code, undefined, 'A'.repeat(43))).toMatchObject({ ok: false, error: { code: 'INVALID_SESSION' } });
  });

  it('rejects a duplicate nickname in the same room', async () => {
    const { url } = await setup();
    const a = new Player(url);
    const b = new Player(url);
    clients.push(a, b);
    await Promise.all([a.connected(), b.connected()]);
    const { code } = await a.create('Arta');
    expect(await b.join(code, 'arta')).toMatchObject({ ok: false, error: { code: 'NAME_TAKEN' } });
  });

  it('rate-limits room creation per IP', async () => {
    const { url } = await setup();
    const p = new Player(url);
    clients.push(p);
    await p.connected();
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await p.call('create_room', { requestId: rid(), nickname: `P${i}` }));
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results[6]).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
  });

  it('create_room retries with the same requestId return the same room', async () => {
    const { url } = await setup();
    const p = new Player(url);
    clients.push(p);
    await p.connected();
    const requestId = rid();
    const a = await p.call<{ code: string }>('create_room', { requestId, nickname: 'Arta' });
    const b = await p.call<{ code: string }>('create_room', { requestId, nickname: 'Arta' });
    expect(a.ok && b.ok && a.data.code === b.data.code).toBe(true);
  });

  it('player_ready is idempotent and deals only when all four are ready', async () => {
    const { players } = await table();
    const [a] = players;
    await a!.call('player_ready', { requestId: rid(), ready: true });
    await a!.call('player_ready', { requestId: rid(), ready: true });
    await a!.until((v) => v.state.seats[0]!.ready);
    expect(a!.state.phase).toBe('LOBBY');
    await readyAll(players);
    for (const p of players) {
      expect(p.view!.you.rack.length).toBe(p.state.starter === p.seat ? 15 : 14);
      expect(p.state.stockCount).toBe(48);
    }
  });
});

describe('gameplay over sockets', () => {
  it('plays legal turns, rejects stale/duplicate commands and never duplicates a draw or discard', async () => {
    const { players } = await table();
    await readyAll(players);
    const starter = bySeat(players, players[0]!.state.starter!);
    const n1 = bySeat(players, (starter.seat! + 1) % 4);
    const n2 = bySeat(players, (starter.seat! + 2) % 4);

    // Double-click: the same discard sent twice with different request ids, concurrently.
    const tile = starter.view!.you.rack[0]!.id;
    const args = turnArgs(starter.view!);
    const [r1, r2] = await Promise.all([
      starter.call('discard_tile', { requestId: rid(), ...args, tileId: tile }),
      starter.call('discard_tile', { requestId: rid(), ...args, tileId: starter.view!.you.rack[1]!.id }),
    ]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    await n1.until((v) => v.state.phase === 'AWAITING_DRAW');
    expect(n1.state.seats[starter.seat!]!.discardCount).toBe(1);
    expect(starter.view!.you.rack.length).toBe(14);

    // Wrong player cannot draw; simultaneous draws from two seats: only the active one succeeds.
    const drawArgs = turnArgs(n1.view!);
    const [good, bad] = await Promise.all([
      n1.call('draw_tile', { requestId: rid(), ...drawArgs, source: 'previous_discard' }),
      n2.call('draw_tile', { requestId: rid(), ...drawArgs, source: 'stock' }),
    ]);
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(['NOT_YOUR_TURN', 'STALE_TURN']).toContain(!bad.ok && bad.error.code);
    await n1.until((v) => v.you.rack.length === 15);

    // Retrying the exact same request id is a harmless replay (no second draw).
    const replayId = rid();
    const discardArgs = turnArgs(n1.view!);
    const discardTile = n1.view!.you.rack[3]!.id;
    expect((await n1.call('discard_tile', { requestId: replayId, ...discardArgs, tileId: discardTile })).ok).toBe(true);
    expect((await n1.call('discard_tile', { requestId: replayId, ...discardArgs, tileId: discardTile })).ok).toBe(true);
    await n2.until((v) => v.state.activeSeat === n2.seat);
    await sleep(50);
    expect(n1.view!.you.rack.length).toBe(14);
    expect(n2.state.seats[n1.seat!]!.discardCount).toBe(1);

    // A stale turn id is rejected.
    expect(await n2.call('draw_tile', { requestId: rid(), ...discardArgs, source: 'stock' })).toMatchObject({ ok: false, error: { code: 'STALE_TURN' } });
    // Discard of a tile the player does not own.
    await n2.call('draw_tile', { requestId: rid(), ...turnArgs(n2.view!), source: 'stock' });
    await n2.until((v) => v.you.rack.length === 15);
    expect(await n2.call('discard_tile', { requestId: rid(), ...turnArgs(n2.view!), tileId: n1.view!.you.rack[0]!.id })).toMatchObject({
      ok: false,
      error: { code: 'TILE_NOT_IN_RACK' },
    });
    expect(n2.state.stockCount).toBe(47);
  });

  it('sorting is private, validated, allowed off-turn, and does not invalidate the active move', async () => {
    const { players } = await table();
    await readyAll(players);
    const starter = bySeat(players, players[0]!.state.starter!);
    const other = bySeat(players, (starter.seat! + 2) % 4);
    const args = turnArgs(starter.view!);
    const rack = other.view!.you.rack;
    const placements = rack.map((e, i) => ({ id: e.id, slot: 23 - i }));
    const versionBefore = starter.state.version;
    expect((await other.call('sort_rack', { requestId: rid(), dealId: args.dealId, placements })).ok).toBe(true);
    await other.until((v) => v.you.rack[0]!.id === rack.at(-1)!.id);
    // The starter's pending discard (computed before the sort) is still valid.
    expect((await starter.call('discard_tile', { requestId: rid(), ...args, tileId: starter.view!.you.rack[0]!.id })).ok).toBe(true);
    expect(starter.state.version).toBeGreaterThanOrEqual(versionBefore);
    // Invalid permutations
    expect(await other.call('sort_rack', { requestId: rid(), dealId: args.dealId, placements: placements.slice(1) })).toMatchObject({ ok: false, error: { code: 'INVALID_PERMUTATION' } });
    const foreign = placements.map((p, i) => (i === 0 ? { ...p, id: starter.view!.you.rack[0]!.id } : p));
    expect(await other.call('sort_rack', { requestId: rid(), dealId: args.dealId, placements: foreign })).toMatchObject({ ok: false, error: { code: 'INVALID_PERMUTATION' } });
  });

  it('closes a round atomically: invalid close preserves state; valid close scores once for everyone', async () => {
    const { players, code, server } = await table();
    server.testApi!.queueDealPlan(code, rigPlan([[...STARTER_WIN, 'y01a'], LOSER_17, LOSER_ZERO, FULL_C]));
    await readyAll(players);
    const starter = bySeat(players, players[0]!.state.starter!);
    const before = JSON.stringify(starter.view);
    const args = turnArgs(starter.view!);
    const bad = await starter.call('declare_win', { requestId: rid(), ...args, tileId: 'r12a' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_CLOSE', details: { reason: 'NOT_FULL_COVER' } } });
    await sleep(50);
    expect(JSON.stringify(starter.view)).toBe(before);

    // Double-click on the close button: two concurrent declares; one scores, the other is stale.
    const [w1, w2] = await Promise.all([
      starter.call('declare_win', { requestId: rid(), ...args, tileId: 'y01a' }),
      starter.call('declare_win', { requestId: rid(), ...args, tileId: 'y01a' }),
    ]);
    expect([w1.ok, w2.ok].sort()).toEqual([false, true]);
    await Promise.all(players.map((p) => p.until((v) => v.state.phase === 'ROUND_RESULT')));
    await sleep(50);
    const s = starter.seat!;
    for (const p of players) {
      expect(p.state.results).toHaveLength(1);
      expect(p.roundResults).toHaveLength(1);
      expect(p.state.totals).toEqual(players[0]!.state.totals);
    }
    const totals = players[0]!.state.totals;
    expect(totals[s]).toBe(-20);
    expect(totals[(s + 1) % 4]).toBe(17);
    expect(totals[(s + 2) % 4]).toBe(0);
    expect(totals[(s + 3) % 4]).toBe(0);
    expect(server.db.results(code)).toHaveLength(1);
  });

  it('never sends opponent racks, stock contents or credentials', async () => {
    const { players, server, code } = await table(7);
    await readyAll(players);
    // Play a few turns so discards become public.
    for (let i = 0; i < 6; i++) {
      await sync(players, server, code);
      const active = bySeat(players, players[0]!.state.activeSeat!);
      if (active.state.phase === 'AWAITING_DRAW') {
        await active.call('draw_tile', { requestId: rid(), ...turnArgs(active.view!), source: 'stock' });
        await active.until((v) => v.state.phase === 'AWAITING_DISCARD');
      }
      const tile = active.view!.you.rack.at(-1)!.id;
      await active.call('discard_tile', { requestId: rid(), ...turnArgs(active.view!), tileId: tile });
      await players[0]!.until((v) => v.state.activeSeat !== active.seat);
    }
    await sleep(100);
    const room = server.rooms.get(code)!;
    const deal = room.game.deal!;
    const stock = new Set(deal.stock);
    const publicTiles = new Set<string>([deal.indicator, ...deal.discards.flat()]);
    // Every tile that was ever discarded is public: collect from every client's received discard tops/events.
    for (const p of players)
      for (const r of p.received) {
        const ev = (r.payload as PlayerView | undefined)?.state?.lastEvent;
        if (ev && ev.type === 'discarded') publicTiles.add(ev.tileId);
      }
    const tokens = players.map((p) => p.token!);
    for (const p of players) {
      const own = new Set<string>();
      for (const r of p.received) if (r.event === 'state_update') (r.payload as PlayerView).you.rack.forEach((e) => own.add(e.id));
      const text = JSON.stringify(p.received);
      const seen = new Set(text.match(TILE_RE) ?? []);
      for (const id of seen) {
        expect(stock.has(id), `stock tile ${id} leaked to seat ${p.seat}`).toBe(false);
        expect(own.has(id) || publicTiles.has(id), `tile ${id} leaked to seat ${p.seat}`).toBe(true);
      }
      expect(text).not.toMatch(/"stock"\s*:\s*\[|"racks"\s*:|token_hash|sessionToken/);
      for (const t of tokens) expect(text).not.toContain(t);
    }
  });

  it('a blocked deal redeals the same round with the same starter and unchanged scores', async () => {
    const { players, server, code } = await table();
    server.testApi!.queueDealPlan(code, rigPlan([[...STARTER_WIN, 'y01a'], FULL_A, LOSER_ZERO, FULL_C]));
    await readyAll(players);
    const starterSeat = players[0]!.state.starter!;
    const firstDeal = players[0]!.state.dealId;
    // Everyone draws from the stock and discards the drawn tile until the stock runs out.
    let guard = 0;
    for (;;) {
      await sync(players, server, code);
      if (players[0]!.state.dealId !== firstDeal || guard++ > 200) break;
      const active = bySeat(players, players[0]!.state.activeSeat!);
      const v = active.view!;
      if (v.state.phase === 'AWAITING_DRAW') {
        const before = new Set(v.you.rack.map((e) => e.id));
        expect((await active.call('draw_tile', { requestId: rid(), ...turnArgs(v), source: 'stock' })).ok).toBe(true);
        const after = await active.until((x) => x.you.rack.length === 15);
        const drawn = after.you.rack.find((e) => !before.has(e.id))!.id;
        expect(await active.call('discard_tile', { requestId: rid(), ...turnArgs(after), tileId: drawn })).toMatchObject({ ok: true });
      } else {
        expect(await active.call('discard_tile', { requestId: rid(), ...turnArgs(v), tileId: 'y01a' })).toMatchObject({ ok: true });
      }
      await players[0]!.until((x) => x.state.version > v.state.version);
    }
    const st = players[0]!.state;
    expect(st.dealId).not.toBe(firstDeal);
    expect(st.starter).toBe(starterSeat);
    expect(st.roundNumber).toBe(1);
    expect(st.blockedDeals).toBe(1);
    expect(st.results).toEqual([]);
    expect(st.stockCount).toBe(48);
    expect(st.lastEvent?.type).toBe('deal_blocked');
  });
});

describe('reconnection and persistence', () => {
  it('reclaims a seat after a disconnect, keeping rack order and holding the turn', async () => {
    const { players, url, code } = await table();
    await readyAll(players);
    const starter = bySeat(players, players[0]!.state.starter!);
    const placements = starter.view!.you.rack.map((e, i) => ({ id: e.id, slot: i < 8 ? 23 - i : i - 8 }));
    await starter.call('sort_rack', { requestId: rid(), dealId: starter.state.dealId, placements });
    const sorted = (await starter.until((v) => v.you.rack.some((e) => e.slot === 23))).you.rack;
    const watcher = bySeat(players, (starter.seat! + 1) % 4);
    starter.close();
    await watcher.until((v) => !v.state.seats[starter.seat!]!.connected);
    expect(watcher.state.activeSeat).toBe(starter.seat);

    const again = new Player(url);
    clients.push(again);
    await again.connected();
    const ack = await again.join(code, undefined, starter.token!);
    expect(ack).toMatchObject({ ok: true, data: { seat: starter.seat, reclaimed: true, sessionToken: null } });
    const v = await again.until((x) => x.you.rack.length === 15);
    expect(v.you.rack).toEqual(sorted);
    expect(v.state.activeSeat).toBe(starter.seat);
    await watcher.until((x) => x.state.seats[starter.seat!]!.connected);
  });

  it('allows only one connection per seat; the stale socket cannot act', async () => {
    const { players, url, code } = await table();
    await readyAll(players);
    const starter = bySeat(players, players[0]!.state.starter!);
    const second = new Player(url);
    clients.push(second);
    await second.connected();
    await second.join(code, undefined, starter.token!);
    await second.until((v) => v.you.seat === starter.seat);
    await sleep(150);
    expect(starter.replaced).toBe(true);
    expect(starter.socket.connected).toBe(false);
    const args = turnArgs(second.view!);
    expect((await second.call('discard_tile', { requestId: rid(), ...args, tileId: second.view!.you.rack[0]!.id })).ok).toBe(true);
  });

  it('restores turn, rack order and scoreboard after a server restart', async () => {
    const dbPath = tempDbPath();
    const first = await startServer(dbPath, 5);
    servers.push(first.server);
    const { players, code } = await fourPlayers(first.url);
    clients.push(...players);
    first.server.testApi!.queueDealPlan(code, rigPlan([[...STARTER_WIN, 'y01a'], LOSER_17, LOSER_ZERO, FULL_C]));
    await readyAll(players);
    const starter = bySeat(players, players[0]!.state.starter!);
    await starter.call('declare_win', { requestId: rid(), ...turnArgs(starter.view!), tileId: 'y01a' });
    await Promise.all(players.map((p) => p.until((v) => v.state.phase === 'ROUND_RESULT')));
    for (const p of players) await p.call('player_ready', { requestId: rid(), ready: true });
    await players[0]!.until((v) => v.state.roundNumber === 2 && v.state.phase === 'AWAITING_DISCARD');
    await sync(players, first.server, code);
    const s2 = bySeat(players, players[0]!.state.starter!);
    await s2.call('discard_tile', { requestId: rid(), ...turnArgs(s2.view!), tileId: s2.view!.you.rack[0]!.id });
    const mover = bySeat(players, (s2.seat! + 1) % 4);
    await mover.until((v) => v.state.activeSeat === mover.seat);
    const reversed = mover.view!.you.rack.map((e, i) => ({ id: e.id, slot: 20 - i }));
    await mover.call('sort_rack', { requestId: rid(), dealId: mover.state.dealId, placements: reversed });
    const beforeRack = (await mover.until((v) => v.you.rack[0]!.slot === 7)).you.rack;
    const beforeState = mover.state;
    const tokens = players.map((p) => ({ seat: p.seat!, token: p.token! }));

    players.forEach((p) => p.close());
    await first.server.close();
    servers = servers.filter((s) => s !== first.server);

    const second = await startServer(dbPath, 6);
    servers.push(second.server);
    const back = await Promise.all(
      tokens.map(async ({ token }) => {
        const p = new Player(second.url);
        clients.push(p);
        await p.connected();
        const ack = await p.join(code, undefined, token);
        expect(ack.ok).toBe(true);
        return p;
      }),
    );
    const m2 = bySeat(back, mover.seat!);
    const v = await m2.until((x) => x.state.seats.every((s) => s.connected));
    expect(v.you.rack).toEqual(beforeRack);
    expect(v.state.activeSeat).toBe(beforeState.activeSeat);
    expect(v.state.turnId).toBe(beforeState.turnId);
    expect(v.state.dealId).toBe(beforeState.dealId);
    expect(v.state.results).toEqual(beforeState.results);
    expect(v.state.totals).toEqual(beforeState.totals);
    // and play continues
    expect((await m2.call('draw_tile', { requestId: rid(), ...turnArgs(v), source: 'previous_discard' })).ok).toBe(true);
  });

  it('plays a full four-round tournament with joint winners and refuses a fifth round', async () => {
    const { players, code, server } = await table(11);
    for (let i = 0; i < 4; i++) server.testApi!.queueDealPlan(code, rigPlan([[...STARTER_WIN, 'y01a'], FULL_A, LOSER_ZERO, FULL_C]));
    await readyAll(players);
    const starters: number[] = [];
    for (let round = 1; round <= 4; round++) {
      await players[0]!.until((v) => v.state.roundNumber === round && v.state.phase === 'AWAITING_DISCARD');
      await sync(players, server, code);
      const st = bySeat(players, players[0]!.state.starter!);
      starters.push(st.seat!);
      await st.until((v) => v.state.roundNumber === round);
      const ack = await st.call('declare_win', { requestId: rid(), ...turnArgs(st.view!), tileId: 'y01a' });
      expect(ack.ok).toBe(true);
      if (round < 4) {
        await Promise.all(players.map((p) => p.until((v) => v.state.phase === 'ROUND_RESULT' && v.state.results.length === round)));
        for (const p of players) await p.call('player_ready', { requestId: rid(), ready: true });
      }
    }
    await Promise.all(players.map((p) => p.until((v) => v.state.phase === 'TOURNAMENT_COMPLETE')));
    await sleep(50);
    expect(new Set(starters).size).toBe(4);
    for (const p of players) {
      expect(p.state.results).toHaveLength(4);
      expect(p.state.totals).toEqual([-20, -20, -20, -20]);
      expect(p.state.winners).toEqual([0, 1, 2, 3]);
      expect(p.tournament?.winners).toEqual([0, 1, 2, 3]);
      expect(p.roundResults).toHaveLength(4);
    }
    expect(await players[0]!.call('player_ready', { requestId: rid(), ready: true })).toMatchObject({ ok: false, error: { code: 'TOURNAMENT_COMPLETE' } });
    expect(server.db.results(code)).toHaveLength(4);
  });
});
