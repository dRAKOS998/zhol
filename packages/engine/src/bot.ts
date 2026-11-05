/**
 * Computer opponent for Zhol. Pure and deterministic: given what a seat may see,
 * return one legal move. The server delays and applies it like any player's command.
 *
 * Strategy: close whenever the rack allows it (with a Zhol for −40 when possible);
 * otherwise keep the hand whose unlinked tiles cost least, counting near-links
 * (pairs that one more tile would complete) as half-made.
 */
import { type SolverConfig, DEFAULT_SOLVER_CONFIG, checkClose, evaluateHand } from './solver.js';
import { type TileId, isZhol, parseTile } from './tiles.js';

export type BotMove =
  | { type: 'draw'; source: 'stock' | 'previous_discard' }
  | { type: 'discard'; tileId: TileId }
  | { type: 'declare_win'; tileId: TileId };

export interface BotInput {
  phase: 'AWAITING_DRAW' | 'AWAITING_DISCARD';
  rack: readonly TileId[];
  /** Top of the previous player's discards (what this seat could take), if any. */
  previousDiscard: TileId | null;
  config?: SolverConfig;
}

/** Two unlinked tiles that a third could join into a run or a set. */
function nearLink(a: TileId, b: TileId): boolean {
  const ta = parseTile(a);
  const tb = parseTile(b);
  if (ta.kind !== 'number' || tb.kind !== 'number') return false;
  if (ta.color === tb.color) {
    const d = Math.abs(ta.rank - tb.rank);
    return d === 1 || d === 2;
  }
  return ta.rank === tb.rank;
}

/** Lower is better: unlinked penalty, eased by near-links and by held Zhols (which are never dead weight). */
export function handScore(ids: readonly TileId[], config: SolverConfig = DEFAULT_SOLVER_CONFIG): number {
  const ev = evaluateHand(ids, config);
  const loose = ev.unlinked.filter((id) => !isZhol(id));
  let score = ev.penalty - ev.unlinked.filter(isZhol).length * config.zholPenalty;
  const paired = new Set<TileId>();
  for (let i = 0; i < loose.length; i++) {
    for (let j = i + 1; j < loose.length; j++) {
      if (nearLink(loose[i]!, loose[j]!)) {
        paired.add(loose[i]!);
        paired.add(loose[j]!);
      }
    }
  }
  for (const id of paired) score -= (parseTile(id) as { rank: number }).rank * 0.55;
  return score;
}

/** The discard that leaves the best hand; never a Zhol unless nothing else is held. */
export function bestDiscard(rack: readonly TileId[], config: SolverConfig = DEFAULT_SOLVER_CONFIG, avoid?: TileId): { tileId: TileId; score: number } {
  const candidates = rack.filter((id) => !isZhol(id) && id !== avoid);
  const pool = candidates.length ? candidates : rack.filter((id) => !isZhol(id)).length ? rack.filter((id) => !isZhol(id)) : [...rack];
  let best: { tileId: TileId; score: number; rank: number } | null = null;
  const seen = new Set<string>();
  for (const id of pool) {
    const face = id.slice(0, 3); // identical faces (two copies) give identical hands
    if (seen.has(face)) continue;
    seen.add(face);
    const rest = rack.filter((x) => x !== id);
    const score = handScore(rest, config);
    const t = parseTile(id);
    const rank = t.kind === 'number' ? t.rank : 0;
    if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && rank > best.rank)) best = { tileId: id, score, rank };
  }
  return { tileId: best!.tileId, score: best!.score };
}

/** A tile whose discard closes the round, preferring a Zhol (−40). */
export function closingDiscard(rack: readonly TileId[], config: SolverConfig = DEFAULT_SOLVER_CONFIG): TileId | null {
  if (rack.length !== 15) return null;
  const order = [...rack.filter(isZhol), ...rack.filter((id) => !isZhol(id))];
  const tried = new Set<string>();
  for (const id of order) {
    const face = isZhol(id) ? 'z' : id.slice(0, 3);
    if (tried.has(face)) continue;
    tried.add(face);
    if (checkClose(rack, id, config).valid) return id;
  }
  return null;
}

export function chooseBotMove(input: BotInput): BotMove {
  const config = input.config ?? DEFAULT_SOLVER_CONFIG;
  const rack = [...input.rack];
  if (input.phase === 'AWAITING_DISCARD') {
    const close = closingDiscard(rack, config);
    if (close) return { type: 'declare_win', tileId: close };
    return { type: 'discard', tileId: bestDiscard(rack, config).tileId };
  }
  const take = input.previousDiscard;
  if (take) {
    const withTake = [...rack, take];
    if (isZhol(take) || closingDiscard(withTake, config)) return { type: 'draw', source: 'previous_discard' };
    const now = handScore(rack, config);
    const after = bestDiscard(withTake, config, take).score;
    if (after < now - 3) return { type: 'draw', source: 'previous_discard' };
  }
  return { type: 'draw', source: 'stock' };
}
