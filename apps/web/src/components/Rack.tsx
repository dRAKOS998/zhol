import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { RACK_SLOTS, SLOTS_PER_ROW, type RackEntry } from '@zhol/engine';
import { TileFace } from './Tile';
import { tileLabel } from '../lib/i18n';

interface RackProps {
  rack: RackEntry[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onLayout: (layout: RackEntry[]) => void;
  /** Changes with every deal; the rack plays its dealing animation when it does. */
  dealKey?: string | null;
  /** Play the dealing animation on first mount too (a deal that has just started). */
  animateDeal?: boolean;
  /** Closing the round: tiles glow to invite choosing the final discard. */
  closeMode?: boolean;
}

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  width: number;
}

/** Move `id` to slot `to`, swapping with any tile already there. */
export function moveInLayout(rack: RackEntry[], id: string, to: number): RackEntry[] {
  const from = rack.find((e) => e.id === id);
  if (!from || from.slot === to) return rack;
  return rack
    .map((e) => (e.id === id ? { ...e, slot: to } : e.slot === to ? { ...e, slot: from.slot } : e))
    .sort((a, b) => a.slot - b.slot);
}

const rowName = (slot: number) => (slot < SLOTS_PER_ROW ? 'rreshti i sipërm' : 'rreshti i poshtëm');
const posName = (slot: number) => `${rowName(slot)}, vendi ${(slot % SLOTS_PER_ROW) + 1}`;

/**
 * Two-tier wooden rack. Reordering supports mouse/touch drag, tap-select then
 * tap an empty slot, and keyboard (arrows move focus, Shift+arrows move the
 * tile, Enter/Space select). Nothing here can discard a tile.
 */
export function Rack({ rack, selected, onSelect, onLayout, dealKey = null, animateDeal = false, closeMode = false }: RackProps) {
  const bySlot = useMemo(() => {
    const m = new Map<number, string>();
    rack.forEach((e) => m.set(e.slot, e.id));
    return m;
  }, [rack]);
  const [focusSlot, setFocusSlot] = useState(() => rack[0]?.slot ?? 0);
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number; width: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const drag = useRef<DragState | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // Dealing animation: tiles drop in one after another when a new deal arrives.
  const [dealing, setDealing] = useState(animateDeal);
  const lastDeal = useRef(dealKey);
  useEffect(() => {
    if (dealKey !== lastDeal.current) {
      lastDeal.current = dealKey;
      setDealing(true);
    }
  }, [dealKey]);
  useEffect(() => {
    if (!dealing) return;
    const t = setTimeout(() => setDealing(false), 1700);
    return () => clearTimeout(t);
  }, [dealing, dealKey]);
  const dealOrder = useMemo(() => new Map(rack.map((e, i) => [e.id, i])), [rack]);

  // Highlight a freshly drawn tile until the rack changes again.
  const prevIds = useRef<Set<string>>(new Set(rack.map((e) => e.id)));
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    const ids = new Set(rack.map((e) => e.id));
    const added = [...ids].filter((id) => !prevIds.current.has(id));
    if (added.length === 1 && ids.size === prevIds.current.size + 1) setFresh(added[0]!);
    else if (added.length !== 0 || ids.size !== prevIds.current.size) setFresh(null);
    prevIds.current = ids;
  }, [rack]);

  const move = (id: string, to: number) => {
    const next = moveInLayout(rack, id, to);
    if (next !== rack) {
      onLayout(next);
      setAnnounce(`${tileLabel(id)} u zhvendos: ${posName(to)}.`);
    }
  };

  const focus = (slot: number) => {
    const s = Math.max(0, Math.min(RACK_SLOTS - 1, slot));
    setFocusSlot(s);
    buttons.current[s]?.focus();
  };

  const toggle = (id: string) => {
    const next = selected === id ? null : id;
    onSelect(next);
    setAnnounce(next ? `${tileLabel(id)} u zgjodh.` : 'Zgjedhja u hoq.');
  };

  // ---- pointer (mouse + touch + pen) ----------------------------------------
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, width: rect.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) d.active = true;
    if (d.active) setGhost({ id: d.id, x: e.clientX, y: e.clientY, width: d.width });
  };
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setGhost(null);
    if (!d.active) return toggle(d.id); // a tap selects
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-slot]');
    if (target) {
      const to = Number(target.dataset.slot);
      move(d.id, to);
      setFocusSlot(to);
    }
  };
  const onPointerCancel = () => {
    drag.current = null;
    setGhost(null);
  };

  // ---- keyboard ----------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = focusSlot;
    const id = bySlot.get(at);
    const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -SLOTS_PER_ROW, ArrowDown: SLOTS_PER_ROW };
    if (e.key in delta) {
      e.preventDefault();
      let to = at + delta[e.key]!;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') to = (to + RACK_SLOTS) % RACK_SLOTS;
      to = Math.max(0, Math.min(RACK_SLOTS - 1, to));
      if (e.shiftKey && id) move(id, to);
      focus(to);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const rowStart = at - (at % SLOTS_PER_ROW);
      return focus(e.key === 'Home' ? rowStart : rowStart + SLOTS_PER_ROW - 1);
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (id) toggle(id);
      else if (selected) move(selected, at);
      return;
    }
    if (e.key === 'Escape' && selected) {
      e.preventDefault();
      onSelect(null);
      setAnnounce('Zgjedhja u hoq.');
    }
  };

  const renderSlot = (slot: number) => {
    const id = bySlot.get(slot);
    const isSel = id !== undefined && id === selected;
    const common = {
      'data-slot': slot,
      tabIndex: slot === focusSlot ? 0 : -1,
      ref: (el: HTMLButtonElement | null) => {
        buttons.current[slot] = el;
      },
      onFocus: () => setFocusSlot(slot),
    };
    if (!id) {
      return (
        <button
          key={slot}
          type="button"
          {...common}
          className="rack-slot rack-slot-empty"
          aria-label={`Vend bosh, ${posName(slot)}${selected ? '. Shtyp për ta vendosur gurin e zgjedhur këtu' : ''}`}
          onClick={() => selected && move(selected, slot)}
        />
      );
    }
    return (
      <button
        key={slot}
        type="button"
        {...common}
        className={`rack-slot rack-slot-tile ${isSel ? 'is-selected' : ''} ${ghost?.id === id ? 'is-dragging' : ''} ${fresh === id ? 'is-fresh' : ''}`}
        style={{ '--d': dealOrder.get(id) ?? 0 } as CSSProperties}
        aria-pressed={isSel}
        aria-label={`${tileLabel(id)}, ${posName(slot)}${isSel ? ', i zgjedhur' : ''}`}
        data-tile={id}
        onPointerDown={(e) => onPointerDown(e, id)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={(e) => {
          // Pointer taps are handled in pointerup; this path is for assistive tech activation.
          if (e.detail === 0) toggle(id);
        }}
      >
        <TileFace id={id} />
      </button>
    );
  };

  return (
    <div className="rack-wrap">
      <p id="rack-help" className="sr-only">
        Shigjetat lëvizin fokusin nëpër raft. Enter ose hapësira zgjedh një gur ose e vendos gurin e zgjedhur në një vend bosh.
        Shift bashkë me një shigjetë e zhvendos gurin. Renditja nuk hedh asnjë gur.
      </p>
      <div className={`rack ${dealing ? 'is-dealing' : ''} ${closeMode ? 'is-closing' : ''}`} role="group" aria-label="Rafti yt" aria-describedby="rack-help" onKeyDown={onKeyDown}>
        {[0, 1].map((row) => (
          <div className="rack-tier" key={row}>
            {Array.from({ length: SLOTS_PER_ROW }, (_, i) => renderSlot(row * SLOTS_PER_ROW + i))}
          </div>
        ))}
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {ghost && (
        <div className="rack-ghost" style={{ left: ghost.x, top: ghost.y, width: ghost.width }} aria-hidden="true">
          <TileFace id={ghost.id} />
        </div>
      )}
    </div>
  );
}
