import { afterEach, describe, expect, it } from 'vitest';
import { createSeededRng } from '@zhol/engine';
import { createZholServer, type ZholServer } from '../src/app.js';
import { Player, rid, tempDbPath, testConfig } from './harness.js';

let servers: ZholServer[] = [];
let clients: Player[] = [];
afterEach(async () => {
  clients.forEach((c) => c.close());
  clients = [];
  for (const s of servers) await s.close().catch(() => {});
  servers = [];
});

const FAST = { ready: [5, 10], draw: [5, 10], discard: [5, 10] } as { ready: [number, number]; draw: [number, number]; discard: [number, number] };

async function host(dbPath = tempDbPath()) {
  const server = createZholServer({ config: testConfig(dbPath), rng: createSeededRng(7), botDelayMs: FAST });
  servers.push(server);
  const port = await server.listen(0);
  const p = new Player(`http://127.0.0.1:${port}`);
  clients.push(p);
  await p.connected();
  await p.create('Arta');
  await p.until((v) => v.state.seats[0]!.name === 'Arta');
  return { server, p, url: `http://127.0.0.1:${port}`, dbPath };
}

describe('2–4 player tables and bots', () => {
  it('the host adds and removes bots; bots are ready and shown as connected', async () => {
    const { p } = await host();
    expect((await p.call('add_bot', { requestId: rid() })).ok).toBe(true);
    expect((await p.call('add_bot', { requestId: rid(), seat: 3 })).ok).toBe(true);
    const v = await p.until((x) => x.state.seats[3]!.bot);
    expect(v.state.seats[1]).toMatchObject({ bot: true, ready: true, connected: true, name: 'Bot Arta' });
    expect(v.state.seats[3]).toMatchObject({ bot: true, name: 'Bot Drini' });
    expect(v.state.players).toEqual([0, 1, 3]);
    expect(v.state.totalRounds).toBe(3);
    expect((await p.call('remove_bot', { requestId: rid(), seat: 1 })).ok).toBe(true);
    const after = await p.until((x) => !x.state.seats[1]!.name);
    expect(after.state.players).toEqual([0, 3]);
  });

  it('only the host may add bots or start', async () => {
    const { p, url } = await host();
    const guest = new Player(url);
    clients.push(guest);
    await guest.connected();
    const ack = await guest.join(p.code!, 'Besi');
    expect(ack.ok).toBe(true);
    const add = await guest.call('add_bot', { requestId: rid() });
    expect(!add.ok && add.error.code).toBe('NOT_HOST');
    const start = await guest.call('start_game', { requestId: rid() });
    expect(!start.ok && start.error.code).toBe('NOT_HOST');
  });

  it('a lone player cannot start; two players can once the guest is ready', async () => {
    const { p, url } = await host();
    const alone = await p.call('start_game', { requestId: rid() });
    expect(!alone.ok && alone.error.code).toBe('NOT_ENOUGH_PLAYERS');
    const guest = new Player(url);
    clients.push(guest);
    await guest.connected();
    await guest.join(p.code!, 'Besi');
    const early = await p.call('start_game', { requestId: rid() });
    expect(!early.ok && early.error.code).toBe('NOT_ALL_READY');
    await guest.call('player_ready', { requestId: rid(), ready: true });
    expect((await p.call('start_game', { requestId: rid() })).ok).toBe(true);
    const v = await p.until((x) => x.state.phase !== 'LOBBY');
    expect(v.state.players).toEqual([0, 1]);
    expect(v.state.totalRounds).toBe(2);
    expect(v.state.stockCount).toBe(76);
  });

  it('a human and a bot play: the bot takes its turns until the human must act', async () => {
    const { p } = await host();
    await p.call('add_bot', { requestId: rid() });
    await p.until((x) => x.state.seats[1]!.bot);
    expect((await p.call('start_game', { requestId: rid() })).ok).toBe(true);
    for (let turn = 0; turn < 6; turn++) {
      const v = await p.until((x) => x.state.activeSeat === 0 || x.state.phase === 'ROUND_RESULT' || x.state.phase === 'TOURNAMENT_COMPLETE', 4000);
      if (v.state.activeSeat !== 0) break;
      if (v.state.phase === 'AWAITING_DRAW') {
        expect((await p.call('draw_tile', { requestId: rid(), dealId: v.state.dealId, turnId: v.state.turnId, source: 'stock' })).ok).toBe(true);
        await p.until((x) => x.state.phase === 'AWAITING_DISCARD' && x.state.activeSeat === 0);
      }
      const w = p.view!;
      const tile = w.you.rack.at(-1)!.id;
      expect((await p.call('discard_tile', { requestId: rid(), dealId: w.state.dealId, turnId: w.state.turnId, tileId: tile })).ok).toBe(true);
      // The bot now draws and discards on its own.
      await p.until((x) => x.state.turnId! >= w.state.turnId! + 3 || x.state.dealId !== w.state.dealId || x.state.phase === 'ROUND_RESULT');
    }
    expect(p.view!.state.seats[1]!.discardCount + p.view!.state.seats[0]!.discardCount).toBeGreaterThan(0);
  });

  it('bot seats survive a restart', async () => {
    const { p, server, dbPath } = await host();
    await p.call('add_bot', { requestId: rid() });
    await p.until((x) => x.state.seats[1]!.bot);
    p.close();
    await server.close();
    servers = servers.filter((s) => s !== server);
    const again = createZholServer({ config: testConfig(dbPath), rng: createSeededRng(8), botDelayMs: FAST });
    servers.push(again);
    expect(again.rooms.get(p.code!)!.bots).toEqual([false, true, false, false]);
  });
});
