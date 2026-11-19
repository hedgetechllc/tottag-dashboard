import { useEffect, useMemo, useRef, useState } from 'react';
import { RADIO_TEST_MAX_SECONDS, tagName } from '@tottag/schema';
import {
  LinkMatrix, ReceptionMatrix, POSITIONS_NOTE, PositionCells, PositionShortcuts, RadioCard, VERDICT_ORDER, usePositions,
} from '../components/RadioResults.tsx';
import { LiveRadioTest, type LiveDevice, type LiveDeviceStatus, type LiveTestState } from '../features/liveRadioTest.ts';
import { formatPercent, runRadioCheck } from '../features/radioCheck.ts';
import { knownTagTransport, useKnownTags } from '../features/useKnownTags.ts';
import { bluetoothTransport, TRANSPORTS, transportFor, useReachableTags } from '../lib/tagAccess.ts';
import { useNow } from '../lib/useNow.ts';

const MIN_MINUTES = 2;
const MAX_MINUTES = Math.min(10, Math.floor(RADIO_TEST_MAX_SECONDS / 60));
const DEFAULT_MINUTES = 2;

const STATUS_LABEL: Record<LiveDeviceStatus, string> = {
  ready: 'Ready', starting: 'Starting', restarting: 'Restarting into the test', waiting: 'Being sent the tag list',
  running: 'Testing', reconnecting: 'Reconnecting', finished: 'Finished', failed: 'Failed',
};
/** A device the scheduler calls idle has not yet been given a slot, and is looking for a network to join. */
const roleLabel = (role: string) => {
  const name = role.replace(/^ROLE_/, '').toLowerCase().replace(/_/g, ' ');
  return name === 'idle' ? 'searching' : name;
};

const STATUS_CLASS: Record<LiveDeviceStatus, string> = {
  ready: 'note', starting: 'note', restarting: 'note', waiting: 'note', running: 'ok', reconnecting: 'warning', finished: 'ok', failed: 'error',
};

/**
 * The radio check run live: the devices range in a radio test while this page reads their ranges and radio counters
 * over Bluetooth. Nothing is logged, a device's deployment is left as it was, and every device goes back to normal by
 * itself when the test ends.
 */
export function LiveRadioCheck({ labelFor }: { labelFor: (eui: Uint8Array) => string | undefined }) {
  const unavailable = bluetoothTransport().unavailableReason();
  // The helper's list has every tag nearby, several at a time, so the list of tags this browser knows is not needed while it runs
  const helperRunning = bluetoothTransport().id === 'helper';
  const { tags: knownTags, remember } = useKnownTags();
  // A tag on USB cannot range, so only tags reached over Bluetooth, by the helper or the browser
  const reachableTags = useReachableTags(knownTags).filter((known) => knownTagTransport(known) !== 'serial');
  const testRef = useRef<LiveRadioTest | null>(null);
  if (!testRef.current) testRef.current = new LiveRadioTest({ reconnect: (handle, transport) => TRANSPORTS[transport].connect(handle) });
  const test = testRef.current;
  useEffect(() => () => test.dispose(), [test]);

  // Re-read the session whenever it reports a change, and every couple of seconds while ranges stream in
  const [version, setVersion] = useState(0);
  useEffect(() => test.subscribe(() => setVersion((v) => v + 1)), [test]);
  const state = test.state();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (state.phase !== 'running') return;
    const timer = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(timer);
  }, [state.phase]);

  const [minutesText, setMinutesText] = useState(String(DEFAULT_MINUTES));
  const minutes = Number(minutesText);
  const minutesValid = Number.isInteger(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;
  const [error, setError] = useState<string | null>(null);
  /** Something is under way that another click could collide with: adding tags, or starting the test. */
  const [busy, setBusy] = useState(false);
  /** What is under way, for as long as nothing else on the page shows it. */
  const [status, setStatus] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const addFromChooser = async () => {
    setError(null);
    setBusy(true);
    try {
      const transport = bluetoothTransport();
      if (transport.requestDevices) {
        // Several at once, from the TotTag Helper's list of tags nearby; each connection is kept for the test
        const missing: string[] = [];
        let total = 0;
        // Not the tags plugged in: a tag plugged into a computer turns its radio off
        const tags = transport.requestDevices((count) => {
          total = count;
          setStatus(`Connecting to the first of ${count} tag${count === 1 ? '' : 's'}…`);
        }, { usb: false });
        for (let index = 1; ; index += 1) {
          const step = await tags.next();
          if (step.done) break;
          if (step.value instanceof Error) {
            missing.push(step.value.message);
          } else {
            const refused = test.add(step.value, labelFor(step.value.identity.eui));
            if (refused) { missing.push(refused); void step.value.disconnect(); }
          }
          if (index < total) setStatus(`Connecting to tag ${index + 1} of ${total}…`);
        }
        if (missing.length) setError(`Could not add ${missing.length} of the ${total} tags picked: ${missing.join(' ')}`);
        return;
      }
      const connection = await transport.requestDevice(() => setStatus('Connecting to the tag…'));
      if (!connection) return;
      const refused = test.add(connection, labelFor(connection.identity.eui));
      if (refused) { setError(refused); void connection.disconnect(); }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setStatus(null);
      setBusy(false);
    }
  };

  const addKnown = async () => {
    setError(null);
    setBusy(true);
    const missing: string[] = [];
    const toAdd = reachableTags.filter((tag) => !state.devices.some((device) => device.handle === tag.handle));
    try {
      for (const [index, tag] of toAdd.entries()) {
        setStatus(`Connecting to ${tagName(tag.eui)} (${index + 1} of ${toAdd.length})…`);
        const connection = await transportFor(tag).connect(tag.handle);
        if (!connection) { missing.push(tagName(tag.eui)); continue; }
        remember(connection.identity);
        const refused = test.add(connection, labelFor(Uint8Array.from(tag.eui)));
        if (refused) { missing.push(refused); void connection.disconnect(); }
      }
      if (missing.length) setError(`Could not add: ${missing.join(', ')}. A tag has to be on its charger, or in a running deployment, to be reached.`);
    } finally {
      setStatus(null);
      setBusy(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try { await test.stop(); } finally { setStopping(false); }
  };

  const start = async () => {
    if (!minutesValid) return;
    setError(null);
    setBusy(true);
    try { await test.start(minutes * 60); } finally { setBusy(false); }
  };

  const deployment = useMemo(() => test.deployment(), [test, version, tick]);
  const positions = usePositions(state.devices.length ? 'tottag.radioCheck.positions.live' : null);
  const result = useMemo(() => (deployment ? runRadioCheck(deployment, positions.positions) : null), [deployment, positions.positions]);
  const judged = result && result.windowStartMs !== null && result.windowEndMs !== null && result.windowEndMs > result.windowStartMs;
  const truncated = state.devices.some((device) => device.truncated > 0);
  const finished = state.phase === 'finished';

  if (unavailable) return <p className="banner banner--warn">{unavailable}</p>;

  return (
    <>
      {state.phase !== 'setup' ? (
        <TestStatus state={state} stopping={stopping} onStop={() => void stop()} onAgain={() => { setError(null); test.again(); }} />
      ) : (
        <section className="panel">
          <h2 className="panel__title">Check tags' radios live</h2>
          <p className="panel__note">
            Runs the tags in a short radio test and reads their distances and receive counts over Bluetooth as it goes,
            to find one with a weak receiver, a damaged antenna, or a distance calibration that is off. Nothing is
            recorded, a tag's deployment is left as it was, and every tag goes back to normal when the test ends.
          </p>
          <ol className="steps">
            <li>Put the tags on their chargers, or leave them running a deployment, so they can be reached.</li>
            <li>{helperRunning ? 'Add the tags, all at once from the list.' : 'Add each tag. The tags used most recently can be added all at once.'}</li>
            <li>Start the test. Each tag restarts into it and begins measuring, on its charger or off it.</li>
            <li>Set them where they can all see each other, at least half a meter apart. The test keeps running as they move.</li>
            <li>Verdicts appear within the first minute and update every 15 seconds; they firm up once every tag has a minute of data.</li>
          </ol>
          <div className="actions">
            <button type="button" className="button" disabled={busy} onClick={() => void addFromChooser()}>Add a tag</button>
            {!helperRunning && (
              <button type="button" className="button button--quiet" disabled={busy || !reachableTags.length}
                onClick={() => void addKnown()}>Add tags used recently</button>
            )}
            <label className="inline-field">
              Run for
              <input className="rtable__input" type="number" inputMode="numeric" min={MIN_MINUTES} max={MAX_MINUTES} step={1}
                value={minutesText} aria-label="Minutes to run the test for"
                onChange={(event) => setMinutesText(event.target.value)} /> minutes
            </label>
            <button type="button" className="button" disabled={state.devices.length < 2 || busy || !minutesValid} onClick={() => void start()}>Start test</button>
          </div>
          {status && <p className="banner banner--info" role="status">{status}</p>}
          {error && <p className="banner banner--crit">{error}</p>}
        </section>
      )}

      {state.devices.length > 0 && (
        <DeviceTable devices={state.devices} onRemove={state.phase === 'setup' ? (handle) => test.remove(handle) : null} busy={busy}
          positions={positions} />
      )}

      {truncated && (
        <p className="banner banner--warn">
          Some distance reports arrived cut short, because this computer's Bluetooth negotiated small packets. Rounds are
          still counted from each tag's own counter, but links to the tags cut off will read low.
        </p>
      )}

      {deployment && result && (
        <>
          <div className="results-head">
            <h2 className="results-head__title">{finished ? 'Final results' : 'Results so far'}</h2>
            <p className="results-head__note">
              {!judged
                ? (finished ? 'The test ended before every tag had 15 seconds of data, so there is nothing to judge.' : 'Verdicts appear once every tag has 15 seconds of data.')
                : finished
                ? 'The test is over, so these will not change.'
                : `Up to ${minutesSeconds(Math.round(result.windowEndMs! / 1000))} into the test. They update every 15 seconds, and can change until the test ends.`}
            </p>
          </div>
          {judged && (
            <>
              {result.notes.map((note) => <p key={note} className="banner banner--warn">{note}</p>)}
              <div className="cards">
                {[...result.devices]
                  .sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.label.localeCompare(b.label))
                  .map((device) => <RadioCard key={device.uid} device={device} provisional={!finished}
                    name={deployment.devices.find((d) => d.uid === device.uid)?.name ?? device.label} />)}
              </div>
              <LinkMatrix devices={deployment.devices} links={result.links} />
              {result.receptions && <ReceptionMatrix devices={deployment.devices} receptions={result.receptions} />}
            </>
          )}
        </>
      )}
    </>
  );
}

/** Whole seconds as "1:05". */
const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Where the test is, pinned at the top of the page: what it is doing, how long is left, and the one thing to do next.
 *
 * The results below look the same whether the test is still running or over, so this has to say which, from
 * anywhere on the page.
 */
function TestStatus({ state, stopping, onStop, onAgain }: {
  state: LiveTestState;
  /** Each tag is being told to stop, which takes a moment per tag before the test says it has ended. */
  stopping: boolean;
  onStop: () => void;
  onAgain: () => void;
}) {
  const now = useNow(1000);
  const { phase, startTime, endTime, finishedAt, stoppedEarly } = state;
  const finished = phase === 'finished';
  const duration = startTime !== null && endTime !== null ? endTime - startTime : null;
  const left = !finished && endTime !== null ? Math.max(0, Math.ceil(endTime - now)) : null;
  const progress = finished ? 1 : startTime !== null && duration ? Math.min(1, Math.max(0, (now - startTime) / duration)) : null;
  const endedAt = finishedAt === null ? '' : new Date(finishedAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const title = stopping ? 'Stopping the test on each tag…'
    : finished ? (stoppedEarly ? 'Test stopped' : 'Test finished')
    : startTime === null ? 'Reaching the tags…'
    : phase === 'starting' ? 'Starting the test on each tag…'
    : left === 0 ? 'Finishing…'
    : 'Test running';
  const detail = !finished ? 'The results below are provisional until the test ends.'
    : startTime === null ? 'Stopped before the test began.'
    : `${stoppedEarly ? 'Stopped' : 'Ended'} at ${endedAt}. Each tag restarts back to what it was doing. The results below are final.`;

  return (
    <section className={`panel run-status${finished ? ' run-status--done' : ''}`}>
      <div className="run-status__row">
        <div className="run-status__text">
          <h2 className="panel__title" aria-live="polite">{title}</h2>
          <p className="panel__note">{detail}</p>
        </div>
        {left !== null && duration !== null && (
          <p className="run-status__clock"><strong>{minutesSeconds(left)}</strong> left of {minutesSeconds(duration)}</p>
        )}
        {finished && !stopping
          ? <button type="button" className="button" onClick={onAgain}>Run another test</button>
          : <button type="button" className="button button--quiet" onClick={onStop} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop test'}</button>}
      </div>
      <div className="transfer__bar" role="progressbar" aria-label="Test progress" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}>
        <div className={`transfer__fill${progress === null ? ' transfer__fill--busy' : ''}`}
          style={progress === null ? undefined : { width: `${progress * 100}%` }} />
      </div>
    </section>
  );
}

function DeviceTable({ devices, onRemove, busy, positions }: {
  devices: readonly LiveDevice[];
  onRemove: ((handle: string) => void) | null;
  /** Tags are being added or the test started, so the list must not change underneath that. */
  busy: boolean;
  /** Where each tag is, optionally, entered in its own row. */
  positions: ReturnType<typeof usePositions>;
}) {
  return (
    <section className="panel">
      <h2 className="panel__title">Tags</h2>
      <table className="rtable">
        <thead>
          <tr>
            <th>Tag</th><th>Status</th><th>Role</th><th>Rounds/s</th><th>Receives failed</th><th>By antenna</th>
            <th>X (m)</th><th>Y (m)</th><th />
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const stats = device.stats;
            const total = stats ? stats.rxOk + stats.rxFailed : 0;
            // The antenna the device uses for schedules, join requests and status exchanges is bracketed
            const antennas = stats ? stats.rxFailedByAntenna.map((failed, i) => {
              const all = failed + stats.rxOkByAntenna[i]!;
              const rate = all ? formatPercent(failed / all) : '—';
              return i === stats.antenna ? `[${rate}]` : rate;
            }).join(' / ') : '—';
            return (
              <tr key={device.handle}>
                <td>{device.label}{device.label !== tagName(device.eui) && <span className="tag-id"> {tagName(device.eui)}</span>}</td>
                <td>
                  <span className={`badge badge--${STATUS_CLASS[device.status]}`}>{STATUS_LABEL[device.status]}</span>
                  {device.message && <div className="panel__note">{device.message}</div>}
                </td>
                <td>{stats ? roleLabel(stats.role) : '—'}</td>
                <td>{device.roundsPerSecond === null ? '—' : device.roundsPerSecond.toFixed(2)}</td>
                <td>{total ? formatPercent(stats!.rxFailed / total) : '—'}</td>
                <td>{antennas}</td>
                <PositionCells uid={device.uid} label={device.label} positions={positions} />
                <td>{onRemove && <button type="button" className="link link--quiet" onClick={() => onRemove(device.handle)} disabled={busy}>Remove</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {devices.some((device) => device.stats) && (
        <p className="panel__note">Brackets in the By antenna column mark the antenna that a tag listens for schedules on.</p>
      )}
      <p className="panel__note">{POSITIONS_NOTE}</p>
      <PositionShortcuts uids={devices.map((device) => device.uid)} positions={positions} />
    </section>
  );
}
