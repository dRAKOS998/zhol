import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import { createSeededRng } from '@zhol/engine';
import type { Ack, ClientToServerEvents, PlayerView, RoundResult, ServerToClientEvents, TournamentResult } from '@zhol/protocol';
import { createZholServer, type ZholServer } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';

export const ORIGIN = 'http://localhost:5173';

export function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhol-test-'));
  return path.join(dir, 'zhol.db');
}

export function testConfig(databasePath: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    allowedOrigins: [ORIGIN],
    publicWebUrl: ORIGIN,
    databasePath,
    trustProxy: false,
    zholPenalty: 20,
    testHarness: true,
    logRequests: false,
    turnSeconds: 0,
    awaySeconds: 0,
    webDistDir: null,
    ...overrides,
  };
}

export async function startServer(databasePath = tempDbPath(), seed = 42, overrides: Partial<ServerConfig> = {}) {
  const server = createZholServer({ config: testConfig(databasePath, overrides), rng: createSeededRng(seed) });
  const port = await server.listen(0);
  return { server, port, url: `http://127.0.0.1:${port}`, databasePath };
}

export const rid = () => randomBytes(8).toString('hex');

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** A test player: records every payload received so we can inspect for leaks. */
export class Player {
  socket: ClientSocket;
  view: PlayerView | null = null;
  received: { event: string; payload: unknown }[] = [];
  roundResults: RoundResult[] = [];
  tournament: TournamentResult | null = null;
  replaced = false;
  token: string | null = null;
  code: string | null = null;
  seat: number | null = null;
  private waiters: (() => void)[] = [];

  constructor(public url: string, origin = ORIGIN) {
    this.socket = connect(url, { transports: ['websocket'], extraHeaders: { origin }, reconnection: false, forceNew: true });
    this.socket.onAny((event, payload) => {
      this.received.push({ event, payload });
    });
    this.socket.on('state_update', (v) => {
      this.view = v;
      this.waiters.splice(0).forEach((w) => w());
    });
    this.socket.on('round_result', (p) => this.roundResults.push(p.result));
    this.socket.on('tournament_result', (p) => (this.tournament = p));
    this.socket.on('session_replaced', () => (this.replaced = true));
  }

  connected() {
    return new Promise<void>((resolve, reject) => {
      if (this.socket.connected) return resolve();
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', (e) => reject(e));
    });
  }

  call<T = Record<string, never>>(event: keyof ClientToServerEvents, payload: Record<string, unknown>): Promise<Ack<T>> {
    return (this.socket.timeout(5000) as unknown as { emitWithAck: (e: string, p: unknown) => Promise<Ack<T>> }).emitWithAck(event, payload);
  }

  async create(nickname: string) {
    const ack = await this.call<{ code: string; seat: number; sessionToken: string | null }>('create_room', { requestId: rid(), nickname });
    if (!ack.ok) throw new Error(ack.error.code);
    this.code = ack.data.code;
    this.seat = ack.data.seat;
    this.token = ack.data.sessionToken;
    return ack.data;
  }

  async join(code: string, nickname?: string, token?: string) {
    const ack = await this.call<{ code: string; seat: number; sessionToken: string | null }>('join_room', {
      requestId: rid(),
      code,
      ...(nickname ? { nickname } : {}),
      ...(token ? { sessionToken: token } : {}),
    });
    if (ack.ok) {
      this.code = ack.data.code;
      this.seat = ack.data.seat;
      if (ack.data.sessionToken) this.token = ack.data.sessionToken;
    }
    return ack;
  }

  /** Resolve once a state update satisfying `pred` has arrived. */
  until(pred: (v: PlayerView) => boolean, timeoutMs = 4000) {
    return new Promise<PlayerView>((resolve, reject) => {
      const check = () => {
        if (this.view && pred(this.view)) {
          clearTimeout(timer);
          resolve(this.view);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for state (phase ${this.view?.state.phase}, turn ${this.view?.state.turnId}, active ${this.view?.state.activeSeat})`)), timeoutMs);
      if (check()) return;
      const loop = () => {
        if (!check()) this.waiters.push(loop);
      };
      this.waiters.push(loop);
    });
  }

  get state() {
    return this.view!.state;
  }

  close() {
    this.socket.disconnect();
  }
}

export async function fourPlayers(url: string) {
  const players = [new Player(url), new Player(url), new Player(url), new Player(url)];
  await Promise.all(players.map((p) => p.connected()));
  const { code } = await players[0]!.create('Arta');
  const names = ['Besi', 'Drita', 'Gëzim'];
  for (let i = 1; i < 4; i++) {
    const ack = await players[i]!.join(code, names[i - 1]);
    if (!ack.ok) throw new Error(ack.error.code);
  }
  return { players, code };
}

export async function readyAll(players: Player[]) {
  for (const p of players) {
    const ack = await p.call('player_ready', { requestId: rid(), ready: true });
    if (!ack.ok) throw new Error(ack.error.code);
  }
  await Promise.all(players.map((p) => p.until((v) => v.state.phase === 'AWAITING_DISCARD' || v.state.phase === 'AWAITING_DRAW')));
}

export const bySeat = (players: Player[], seat: number) => players.find((p) => p.seat === seat)!;

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type { ZholServer };

/** Wait until every player has received the server's current room version. */
export async function sync(players: Player[], server: ZholServer, code: string) {
  const version = server.rooms.get(code)!.version;
  await Promise.all(players.filter((p) => p.socket.connected).map((p) => p.until((v) => v.state.version >= version)));
}
