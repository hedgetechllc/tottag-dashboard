// What the radio check shows, whichever way its data arrived: a card per tag and the link matrix, shared by the
// check from downloaded logs and the live check over Bluetooth, so the two cannot drift into showing the same
// result differently. And where each tag is, which only the live check asks for, in its table of tags: a
// deployment's logs say nothing about where the tags were.

import { useEffect, useMemo, useState } from 'react';
import { NO_REFERENCE_NOTE, type RadioCheckDevice, type RadioCheckLink, type RadioVerdict, type Reception } from '@tottag/schema';
import { Stat } from './Stat.tsx';
import { circlePositions, formatMm, formatPercent, linePositions, type Positions, type RadioDevice } from '../features/radioCheck.ts';

export const VERDICT_LABEL: Record<RadioVerdict, string> = { pass: 'Pass', check: 'Check', fail: 'Fail', missing: 'No log', unknown: 'Unknown' };
export const VERDICT_CLASS: Record<RadioVerdict, string> = { pass: 'ok', check: 'note', fail: 'warning', missing: 'error', unknown: 'unknown' };
export const VERDICT_ORDER: Record<RadioVerdict, number> = { fail: 0, check: 1, unknown: 2, missing: 3, pass: 4 };

/** The check's notes, the one saying why every verdict is unknown in the verdict's own colour. */
export function RadioNotes({ notes }: { notes: readonly string[] }) {
  return (
    <>
      {notes.map((note) => <p key={note} className={`banner banner--${note === NO_REFERENCE_NOTE ? 'unknown' : 'warn'}`}>{note}</p>)}
    </>
  );
}

/** Entered positions as typed, so a half-typed "1." is not reformatted under the cursor. */
type PositionText = Record<number, { x: string; y: string }>;

function toPositions(text: PositionText): Positions {
  const out = new Map<number, { x: number; y: number }>();
  for (const [uid, value] of Object.entries(text)) {
    const x = Number.parseFloat(value.x);
    const y = Number.parseFloat(value.y);
    if (Number.isFinite(x) && Number.isFinite(y)) out.set(Number(uid), { x, y });
  }
  return out;
}

function fromPositions(positions: Positions): PositionText {
  return Object.fromEntries([...positions].map(([uid, p]) => [uid, { x: String(p.x), y: String(p.y) }]));
}

/** Positions entered for one test, remembered in this browser so re-opening it does not mean re-measuring. */
export function usePositions(storageKey: string | null) {
  const [text, setText] = useState<PositionText>({});
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      setText(raw ? (JSON.parse(raw) as PositionText) : {});
    } catch {
      setText({});
    }
  }, [storageKey]);
  const update = (next: PositionText) => {
    setText(next);
    try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* private window */ }
  };
  const positions = useMemo(() => toPositions(text), [text]);
  return { text, positions, update };
}

/** What entering positions does, said once wherever they are entered. */
export const POSITIONS_NOTE = 'Where each tag is, if you like: in meters, from any corner. With at least three, the check works out whether one tag reads long or short on every link.';

/** One tag's X and Y, as two cells of a table row that names the tag. */
export function PositionCells({ uid, label, positions }: {
  uid: number;
  label: string;
  positions: ReturnType<typeof usePositions>;
}) {
  const { text, update } = positions;
  return (
    <>
      {(['x', 'y'] as const).map((axis) => (
        <td key={axis}>
          <input
            className="rtable__input" inputMode="decimal" aria-label={`${label} ${axis.toUpperCase()} in meters`}
            value={text[uid]?.[axis] ?? ''}
            onChange={(event) => update({ ...text, [uid]: { x: text[uid]?.x ?? '', y: text[uid]?.y ?? '', [axis]: event.target.value } })}
          />
        </td>
      ))}
    </>
  );
}

/** Filling every tag's position in at once, for tags set out in a circle or a line, and clearing them. */
export function PositionShortcuts({ uids, positions }: { uids: readonly number[]; positions: ReturnType<typeof usePositions> }) {
  const { update } = positions;
  const [radius, setRadius] = useState('1');
  const [spacing, setSpacing] = useState('1');
  return (
    <div className="actions">
      <label className="inline-field">
        Circle of radius
        <input className="rtable__input" inputMode="decimal" value={radius} onChange={(event) => setRadius(event.target.value)} /> m
      </label>
      <button type="button" className="button button--quiet"
        onClick={() => update(fromPositions(circlePositions(uids, Number.parseFloat(radius) || 1)))}>
        Fill in a circle
      </button>
      <label className="inline-field">
        Line spaced
        <input className="rtable__input" inputMode="decimal" value={spacing} onChange={(event) => setSpacing(event.target.value)} /> m
      </label>
      <button type="button" className="button button--quiet"
        onClick={() => update(fromPositions(linePositions(uids, Number.parseFloat(spacing) || 1)))}>
        Fill in a line
      </button>
      <button type="button" className="button button--quiet" onClick={() => update({})}>Clear positions</button>
    </div>
  );
}

/** One tag's verdict. Provisional while a live test is still running, when the verdict can still change. */
export function RadioCard({ device, name, provisional = false, referenced = false }: {
  device: RadioCheckDevice; name: string; provisional?: boolean;
  /** Whether any tag was shown healthy to measure this one against, rather than all the others. */
  referenced?: boolean;
}) {
  const partners = referenced ? 'the healthy tags' : 'the other tags';
  const antennas = device.antennaFailureRates.map((rate, i) => `${i + 1}: ${formatPercent(rate)}`).join('  ');
  // With receives counted by sender, its own receiving and sending, its partners allowed for, stand in for the raw
  // failures, which a bad partner inflates
  const quality = device.quality;
  const missed = (share: number | null) => (share === null ? null : 1 - share);
  const byAntenna = (shares: ReadonlyArray<number | null>) => shares.map((share, i) => `${i + 1}: ${formatPercent(missed(share))}`).join('  ');
  const verdict = `${VERDICT_LABEL[device.verdict]}${provisional && device.verdict !== 'missing' ? ' so far' : ''}`;
  return (
    <article className={`card card--${VERDICT_CLASS[device.verdict]}${provisional ? ' card--provisional' : ''}`}>
      <header className="card__head">
        <div>
          <h3 className="card__title">{device.label}</h3>
          {device.label !== name && <p className="card__sub">{name}</p>}
        </div>
        <span className={`badge badge--${VERDICT_CLASS[device.verdict]}`}>{verdict}</span>
      </header>
      {device.verdict !== 'missing' && (
        <dl className="stats">
          <Stat label="Rounds ranged" value={formatPercent(device.participation)} />
          {quality ? (
            <>
              <Stat label="Fails to hear" value={formatPercent(missed(quality.hears))} hint={`of what ${partners} sent`} />
              <Stat label="Goes unheard" value={formatPercent(missed(quality.heard))} hint={`by ${partners}`} />
              <Stat label="Fails to hear, by antenna" value={byAntenna(quality.hearsByAntenna) || '—'} />
              <Stat label="Goes unheard, by antenna" value={byAntenna(quality.heardByAntenna) || '—'} />
            </>
          ) : (
            <>
              <Stat label="Receives failed" value={formatPercent(device.rxFailureRate)} />
              <Stat label="Failed by antenna" value={antennas || '—'} />
            </>
          )}
          <Stat label="Typical link" value={formatPercent(device.linkCoverage)} hint={`of rounds with a range to a given ${referenced ? 'healthy tag' : 'peer'}`} />
          <Stat label="Distance offset" value={device.biasMm === null ? '—' : `${device.biasMm > 0 ? '+' : ''}${Math.round(device.biasMm)} mm`} />
          <Stat label="Distance spread" value={formatMm(device.noiseMm)} hint={referenced ? 'to the healthy tags' : undefined} />
        </dl>
      )}
      {device.reasons.length > 0 && (
        <ul className="findings">
          {device.reasons.map((reason) => (
            <li key={reason} className={`finding finding--${device.verdict === 'fail' ? 'warn' : 'note'}`}>
              <div className="finding__body"><p className="finding__text">{reason}</p></div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * Every tag's receives from every other, read along a row: how often that tag decoded what the column's sent. A row
 * low across the board is a tag that hears poorly, or one with something transmitting near it; a column low across
 * the board is a tag the others cannot hear.
 */
export function ReceptionMatrix({ devices, receptions }: { devices: readonly RadioDevice[]; receptions: readonly Reception[] }) {
  if (devices.length < 2) return null;
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  return (
    <section className="panel">
      <h2 className="panel__title">Receives</h2>
      <p className="panel__note">
        How often the tag in each row decoded what the tag in each column sent. A row low across the board is a tag that
        hears poorly, or one near something else transmitting; a column low across the board is a tag the others cannot
        hear. Hover a cell for each antenna.
      </p>
      <div className="matrix__scroll">
        <table className="matrix">
          <thead>
            <tr><th />{devices.map((device) => <th key={device.uid} scope="col">{device.label}</th>)}</tr>
          </thead>
          <tbody>
            {devices.map((row) => (
              <tr key={row.uid}>
                <th scope="row">{row.label}</th>
                {devices.map((column) => {
                  if (row.uid === column.uid) return <td key={column.uid} className="matrix__self" />;
                  const counts = receptions.find((r) => r.receiver === row.uid && r.sender === column.uid);
                  const total = counts ? sum(counts.rxOk) + sum(counts.rxFailed) : 0;
                  if (!counts || !total) return <td key={column.uid} className="matrix__cell" title={`${row.label} ← ${column.label}: nothing received`}>—</td>;
                  const share = sum(counts.rxOk) / total;
                  const band = share >= 0.95 ? 'good' : share >= 0.85 ? 'fair' : 'poor';
                  const perAntenna = counts.rxOk.map((ok, antenna) => {
                    const all = ok + (counts.rxFailed[antenna] ?? 0);
                    return `antenna ${antenna + 1}: ${all ? formatPercent(ok / all) : '—'}`;
                  }).join(', ');
                  return (
                    <td key={column.uid} className={`matrix__cell matrix__cell--${band}`} title={`${row.label} ← ${column.label}: ${perAntenna}`}>
                      {formatPercent(share)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Coverage between every pair, read along a row: how often that tag ranged to the column's. */
export function LinkMatrix({ devices, links }: { devices: readonly RadioDevice[]; links: readonly RadioCheckLink[] }) {
  if (devices.length < 2) return null;
  const find = (a: number, b: number) => links.find((link) => (link.a === a && link.b === b) || (link.a === b && link.b === a));
  return (
    <section className="panel">
      <h2 className="panel__title">Links</h2>
      <p className="panel__note">
        How often the tag in each row measured a distance to the tag in each column. A tag weak on every link is
        the problem; one weak pair is more likely something between them. Hover a cell for its distance.
      </p>
      <div className="matrix__scroll">
        <table className="matrix">
          <thead>
            <tr><th />{devices.map((device) => <th key={device.uid} scope="col">{device.label}</th>)}</tr>
          </thead>
          <tbody>
            {devices.map((row) => (
              <tr key={row.uid}>
                <th scope="row">{row.label}</th>
                {devices.map((column) => {
                  if (row.uid === column.uid) return <td key={column.uid} className="matrix__self" />;
                  const link = find(row.uid, column.uid);
                  const coverage = link ? (link.a === row.uid ? link.coverageAtoB : link.coverageBtoA) : 0;
                  const band = coverage >= 0.9 ? 'good' : coverage >= 0.7 ? 'fair' : 'poor';
                  const detail = link?.medianMm !== null && link?.medianMm !== undefined
                    ? `${formatMm(link.medianMm)} ± ${formatMm(link.noiseMm)}${link.residualMm !== null ? `, ${link.residualMm > 0 ? '+' : ''}${Math.round(link.residualMm)} mm from the positions` : ''}`
                    : 'no ranges';
                  return (
                    <td key={column.uid} className={`matrix__cell matrix__cell--${band}`} title={`${row.label} → ${column.label}: ${detail}`}>
                      {formatPercent(coverage)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
