import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { GameMode } from '@zhol/protocol';

export const MODE_INFO: Record<GameMode, { name: string; short: string; rule: string }> = {
  klasik: {
    name: 'Zhol Klasik',
    short: 'Klasik',
    rule: 'Një raund për çdo lojtar. Pikët mblidhen, fiton kush ka më pak.',
  },
  shpejte: {
    name: 'Zhol i Shpejtë',
    short: 'I Shpejtë',
    rule: 'Një raund i vetëm, pa pikë. Kush mbyll i pari, fiton.',
  },
};

export function BoltIcon({ className = 'icon' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M13.5 1.5 4 13.6h6.3L8.6 22.5 20 9.6h-6.6l3-8.1z" fill="currentColor" />
    </svg>
  );
}

/** Small label in the lobby so everyone knows which game they joined. */
export function ModeBadge({ mode }: { mode: GameMode }) {
  const info = MODE_INFO[mode];
  return (
    <p className={`mode-badge mode-badge-${mode}`}>
      {mode === 'shpejte' ? <BoltIcon /> : <span className="mode-badge-pips" aria-hidden="true"><i /><i /><i /><i /></span>}
      <span>
        <b>{info.name}</b> <span className="mode-badge-rule">{info.rule}</span>
      </span>
    </p>
  );
}

/** The face printed on each mode tile. */
function Face({ mode }: { mode: GameMode }) {
  if (mode === 'klasik') {
    return (
      <span className="mt-face" aria-hidden="true">
        <span className="mt-num">4</span>
        <span className="mt-pips">
          {[0, 1, 2, 3].map((i) => (
            <i key={i} style={{ '--i': i } as CSSProperties} />
          ))}
        </span>
        <span className="mt-ledger">
          <span>−20</span>
          <span>+17</span>
          <span>−40</span>
        </span>
      </span>
    );
  }
  return (
    <span className="mt-face" aria-hidden="true">
      <span className="mt-num">1</span>
      <BoltIcon className="mt-bolt" />
      <span className="mt-streaks">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

/** Tilt toward the pointer, like picking a tile up off the felt. */
function tilt(e: PointerEvent<HTMLElement>) {
  if (e.pointerType !== 'mouse') return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  e.currentTarget.style.setProperty('--ry', `${(x * 14).toFixed(2)}deg`);
  e.currentTarget.style.setProperty('--rx', `${(-y * 12).toFixed(2)}deg`);
}
function untilt(e: PointerEvent<HTMLElement>) {
  e.currentTarget.style.removeProperty('--rx');
  e.currentTarget.style.removeProperty('--ry');
}

export function ModePicker({ value, onChange }: { value: GameMode | null; onChange: (m: GameMode) => void }) {
  const modes: GameMode[] = ['klasik', 'shpejte'];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = value ? modes.indexOf(value) : -1;
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = modes[(i + step + modes.length) % modes.length]!;
    onChange(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };
  return (
    <div className={`mode-picker ${value ? 'has-pick' : ''}`} role="radiogroup" aria-labelledby="mode-h" onKeyDown={onKey}>
      {modes.map((m, i) => {
        const on = value === m;
        const info = MODE_INFO[m];
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (!value && i === 0) ? 0 : -1}
            data-mode={m}
            className={`mode-tile mode-${m} ${on ? 'is-on' : ''}`}
            style={{ '--d': `${0.25 + i * 0.12}s` } as CSSProperties}
            onClick={() => onChange(m)}
            onPointerMove={tilt}
            onPointerLeave={untilt}
          >
            <span className="mt-slab">
              <Face mode={m} />
              {on && <span className="mt-check" aria-hidden="true" />}
            </span>
            <span className="mt-name">{info.name}</span>
            <span className="mt-rule">{info.rule}</span>
          </button>
        );
      })}
    </div>
  );
}
