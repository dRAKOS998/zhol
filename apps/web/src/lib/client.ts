import { io, type Socket } from 'socket.io-client';
import { useSyncExternalStore } from 'react';
import { RACK_SLOTS, type RackEntry } from '@zhol/engine';
import type {
  Ack,
  ClientToServerEvents,
  DrawSource,
  PlayerView,
  ProtocolError,
  RoomJoined,
  ServerToClientEvents,
} from '@zhol/protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'replaced';

export interface ClientSnapshot {
  status: ConnectionStatus;
  /** Room this tab is trying to be seated in. */
  roomCode: string | null;
  seat: number | null;
  view: PlayerView | null;
  /** Locally reordered rack waiting for the server to confirm. */
  pendingRack: RackEntry[] | null;
  /** Set when an automatic seat reclaim failed and the player must join by name. */
  reclaimError: ProtocolError | null;
  /** Local time (ms) at which the computer will move for the active player, or null when nobody is on the clock. */
  turnDeadline: number | null;
}

// VITE_SERVER_URL wins. Otherwise: dev talks to :3001 on the same host; a production build assumes the
// server also serves the web app (same origin).
const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') ||
  (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3001` : window.location.origin);

const tokenKey = (code: string) => `zhol.session.${code}`;
export const NAME_KEY = 'zhol.nickname';

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode); seat reclaim then lasts for this tab only */
  }
}
export const savedName = () => storageGet(NAME_KEY) ?? '';
export const hasSessionFor = (code: string) => storageGet(tokenKey(code)) !== null;

function requestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const timeoutError: ProtocolError = { code: 'INTERNAL_ERROR', message: 'timeout', details: { timeout: true } };

/** Merge a local rack layout with the authoritative rack: keep local slots for tiles we still hold. */
export function mergeRack(local: RackEntry[] | null, server: RackEntry[]): RackEntry[] {
  if (!local) return server;
  const held = new Set(server.map((e) => e.id));
  const kept = local.filter((e) => held.has(e.id));
  const used = new Set(kept.map((e) => e.slot));
  const known = new Set(kept.map((e) => e.id));
  const out = [...kept];
  for (const e of server) {
    if (known.has(e.id)) continue;
    let slot = e.slot;
    if (used.has(slot)) slot = [...Array(RACK_SLOTS).keys()].find((s) => !used.has(s))!;
    used.add(slot);
    out.push({ id: e.id, slot });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

class ZholClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private sortSeq = 0;
  private snap: ClientSnapshot = { status: 'connecting', roomCode: null, seat: null, view: null, pendingRack: null, reclaimError: null, turnDeadline: null };
  private roundListeners = new Set<() => void>();

  constructor() {
    this.socket = io(SERVER_URL, { transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
    this.socket.on('connect', () => {
      this.set({ status: 'connected' });
      // Reclaim our seat on every (re)connect, e.g. after a refresh or server restart.
      if (this.snap.roomCode && storageGet(tokenKey(this.snap.roomCode))) void this.reclaim(this.snap.roomCode);
    });
    this.socket.on('disconnect', (reason) => {
      if (this.snap.status === 'replaced') return;
      this.set({ status: reason === 'io server disconnect' ? 'offline' : 'reconnecting' });
    });
    this.socket.io.on('reconnect_attempt', () => this.snap.status !== 'replaced' && this.set({ status: 'reconnecting' }));
    this.socket.on('connect_error', () => this.set({ status: this.snap.view ? 'reconnecting' : 'offline' }));
    this.socket.on('session_replaced', () => this.set({ status: 'replaced' }));
    this.socket.on('state_update', (view) => {
      if (this.snap.roomCode && view.state.code !== this.snap.roomCode) return;
      const sameDeal = this.snap.view?.state.dealId === view.state.dealId;
      const left = view.state.turnEndsInMs;
      this.set({ view, seat: view.you.seat, pendingRack: sameDeal ? this.snap.pendingRack : null, turnDeadline: typeof left === 'number' ? Date.now() + left : null });
    });
    this.socket.on('round_result', () => this.roundListeners.forEach((l) => l()));
  }

  // ---- store plumbing ------------------------------------------------------
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<ClientSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }
  onRoundResult(l: () => void) {
    this.roundListeners.add(l);
    return () => this.roundListeners.delete(l);
  }

  /** Emit with an acknowledgment; retries timeouts with the SAME requestId so the server can deduplicate. */
  private async emit<T>(event: keyof ClientToServerEvents, payload: Record<string, unknown>, attempts = 3): Promise<Ack<T>> {
    for (let i = 0; i < attempts; i++) {
      try {
        const emitter = this.socket.timeout(6000) as unknown as { emitWithAck(e: string, p: unknown): Promise<Ack<T>> };
        return await emitter.emitWithAck(event, payload);
      } catch {
        if (!this.socket.connected) await new Promise((r) => setTimeout(r, 800));
      }
    }
    return { ok: false, error: { ...timeoutError, code: 'INTERNAL_ERROR' } };
  }

  /** Serialize commands so a tab never races itself. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- rooms ---------------------------------------------------------------
  async createRoom(nickname: string): Promise<Ack<RoomJoined>> {
    storageSet(NAME_KEY, nickname.trim());
    const ack = await this.enqueue(() => this.emit<RoomJoined>('create_room', { requestId: requestId(), nickname }));
    if (ack.ok) this.adopt(ack.data);
    return ack;
  }

  async joinRoom(code: string, nickname: string): Promise<Ack<RoomJoined>> {
    storageSet(NAME_KEY, nickname.trim());
    this.set({ roomCode: code, reclaimError: null });
    const ack = await this.enqueue(() => this.emit<RoomJoined>('join_room', { requestId: requestId(), code, nickname }));
    if (ack.ok) this.adopt(ack.data);
    return ack;
  }

  /** Enter a room page: reclaim a stored seat if we have one. Returns false when the player must join by name. */
  enterRoom(code: string): boolean {
    if (this.snap.roomCode !== code) this.set({ roomCode: code, view: null, seat: null, pendingRack: null, reclaimError: null, turnDeadline: null });
    if (!storageGet(tokenKey(code))) return false;
    if (this.socket.connected) void this.reclaim(code);
    return true;
  }

  leaveRoomView() {
    this.set({ roomCode: null, view: null, seat: null, pendingRack: null, reclaimError: null, turnDeadline: null });
  }

  /** Take back this tab's seat after a 'replaced' notice. */
  retake() {
    this.set({ status: 'connecting' });
    this.socket.connect();
  }

  private async reclaim(code: string) {
    const token = storageGet(tokenKey(code));
    if (!token) return;
    const ack = await this.enqueue(() => this.emit<RoomJoined>('join_room', { requestId: requestId(), code, sessionToken: token }));
    if (ack.ok) this.adopt(ack.data);
    else if (ack.error.code === 'INVALID_SESSION' || ack.error.code === 'ROOM_NOT_FOUND') {
      storageSet(tokenKey(code), null);
      this.set({ reclaimError: ack.error });
    } else this.set({ reclaimError: ack.error });
  }

  private adopt(data: RoomJoined) {
    if (data.sessionToken) storageSet(tokenKey(data.code), data.sessionToken);
    this.set({ roomCode: data.code, seat: data.seat, reclaimError: null });
  }

  // ---- gameplay --------------------------------------------------------------
  private turn() {
    const s = this.snap.view?.state;
    return { dealId: s?.dealId ?? 'd0', turnId: s?.turnId ?? 0 };
  }

  setReady(ready: boolean) {
    return this.enqueue(() => this.emit('player_ready', { requestId: requestId(), ready }));
  }

  /** "I'm here": take my seat back after the computer played for me. */
  playerBack() {
    return this.enqueue(() => this.emit('player_back', { requestId: requestId() }));
  }

  addBot(seat?: number) {
    return this.enqueue(() => this.emit('add_bot', { requestId: requestId(), ...(seat === undefined ? {} : { seat }) }));
  }

  removeBot(seat: number) {
    return this.enqueue(() => this.emit('remove_bot', { requestId: requestId(), seat }));
  }

  startGame() {
    return this.enqueue(() => this.emit('start_game', { requestId: requestId() }));
  }

  draw(source: DrawSource) {
    const args = this.turn();
    return this.enqueue(() => this.emit('draw_tile', { requestId: requestId(), ...args, source }));
  }

  discard(tileId: string) {
    const args = this.turn();
    return this.enqueue(() => this.emit('discard_tile', { requestId: requestId(), ...args, tileId }));
  }

  declareWin(tileId: string) {
    const args = this.turn();
    return this.enqueue(() => this.emit('declare_win', { requestId: requestId(), ...args, tileId }));
  }

  /** Reorder locally at once; the server receives the layout merged with whatever we hold when the command runs. */
  sortRack(layout: RackEntry[]) {
    const seq = ++this.sortSeq;
    this.set({ pendingRack: layout });
    return this.enqueue(async () => {
      const view = this.snap.view;
      if (!view?.state.dealId) return { ok: true } as Ack;
      const placements = mergeRack(this.snap.pendingRack, view.you.rack);
      const ack = await this.emit('sort_rack', { requestId: requestId(), dealId: view.state.dealId, placements });
      if (seq === this.sortSeq) this.set({ pendingRack: ack.ok ? placements : null });
      return ack;
    });
  }
}

export const client = new ZholClient();

export function useClient(): ClientSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

/** Rack as the player should see it right now. */
export function displayRack(snap: ClientSnapshot): RackEntry[] {
  return snap.view ? mergeRack(snap.pendingRack, snap.view.you.rack) : [];
}

export function isTimeout(err: ProtocolError) {
  return err.details?.timeout === true;
}
