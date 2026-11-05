import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { TileBack, TileFace } from './Tile';

/** One tile travelling across the table: from one element's box to another's, along an arc. */
export interface Flight {
  key: number;
  from: DOMRect;
  to: DOMRect;
  /** Face shown in flight; null flies face-down. */
  tile: string | null;
  delay: number;
  duration: number;
  /** Lift of the arc's apex, in px (negative = up). */
  arc: number;
  spin: number;
}

export type FlightRequest = Omit<Flight, 'key' | 'delay' | 'duration' | 'arc' | 'spin'> & Partial<Pick<Flight, 'delay' | 'duration' | 'arc' | 'spin'>>;

export const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let seq = 0;

export function useFlights() {
  const [flights, setFlights] = useState<Flight[]>([]);
  const launch = useCallback((reqs: FlightRequest[]) => {
    if (reducedMotion() || !reqs.length) return;
    setFlights((f) => [
      ...f,
      ...reqs.map((r) => ({ delay: 0, duration: 460, arc: -60, spin: (Math.random() - 0.5) * 24, ...r, key: ++seq })),
    ]);
  }, []);
  const done = useCallback((key: number) => setFlights((f) => f.filter((x) => x.key !== key)), []);
  return { flights, launch, done };
}

function FlyingTile({ flight, onDone }: { flight: Flight; onDone: (key: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { from, to } = flight;
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    const tx = to.left + to.width / 2;
    const ty = to.top + to.height / 2;
    const s0 = Math.max(0.35, Math.min(2.2, from.width / Math.max(1, to.width)));
    const mx = (fx + tx) / 2;
    const my = (fy + ty) / 2 + flight.arc;
    const anim = el.animate(
      [
        { transform: `translate(${fx}px, ${fy}px) translate(-50%, -50%) scale(${s0}) rotate(0deg)`, opacity: 0.2, offset: 0 },
        { transform: `translate(${fx}px, ${fy}px) translate(-50%, -50%) scale(${s0 * 1.08}) rotate(0deg)`, opacity: 1, offset: 0.08 },
        { transform: `translate(${mx}px, ${my}px) translate(-50%, -50%) scale(${(s0 + 1) / 2 + 0.18}) rotate(${flight.spin}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${tx}px, ${ty}px) translate(-50%, -50%) scale(1) rotate(0deg)`, opacity: 1, offset: 1 },
      ],
      { duration: flight.duration, delay: flight.delay, easing: 'cubic-bezier(.35,.1,.25,1)', fill: 'both' },
    );
    anim.onfinish = () => onDone(flight.key);
    return () => {
      // Unmount (or a StrictMode re-run): stop quietly; only a finished flight removes itself.
      anim.onfinish = null;
      anim.cancel();
    };
  }, [flight, onDone]);
  return (
    <div ref={ref} className="flying-tile" style={{ width: flight.to.width }} aria-hidden="true">
      {flight.tile ? <TileFace id={flight.tile} size="rack" /> : <TileBack className="tile-fill" />}
    </div>
  );
}

export function FlightLayer({ flights, onDone }: { flights: Flight[]; onDone: (key: number) => void }) {
  return (
    <div className="flight-layer" aria-hidden="true">
      {flights.map((f) => (
        <FlyingTile key={f.key} flight={f} onDone={onDone} />
      ))}
    </div>
  );
}

/** Box of the element tagged `data-anchor="<name>"`, if it is on screen. */
export function anchorRect(name: string): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`[data-anchor="${name}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

/** A tile-sized box centred inside `r` (for flights that end on a name plaque or a rack). */
export function tileBoxIn(r: DOMRect, width: number): DOMRect {
  const h = width * 1.4;
  return new DOMRect(r.left + r.width / 2 - width / 2, r.top + r.height / 2 - h / 2, width, h);
}
