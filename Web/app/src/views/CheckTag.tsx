import { useCallback, useState } from 'react';
import { formatEui, tagName } from '@tottag/schema';
import { webSerialTransport } from '../adapters/webSerial.ts';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { LiveRanges, useLiveRanges } from '../components/LiveRanges.tsx';
import { TagDetails } from '../components/TagFacts.tsx';
import { assessSnapshot, mayHoldData, OFF_CHARGER_HINT, storedState } from '../features/tagStatus.ts';
import { describeKnownTag, useKnownTags, type KnownTag } from '../features/useKnownTags.ts';
import { useDownloaded, useTagChecks } from '../features/useTagRecords.ts';
import {
  bluetoothTransport, connectTo, errorText, routeTo, unlistedNote, unreachableMessage, useReachableTags, withTag,
} from '../lib/tagAccess.ts';
import { useNow } from '../lib/useNow.ts';
import type { TagConnection, TagTransport } from '../ports/tagTransport.ts';

const BUZZ_SECONDS = 10;

/**
 * One tag, looked at on its own: its battery, its clock, and what deployment it holds.
 *
 * The desktop tool's per-device actions — device details, voltage, timestamp, the scheduled deployment
 * read back, find my TotTag, cancel — in one place, and in words.
 */
export function CheckTag({ timezone, onAddToDeployment, inDeployment }: {
  timezone: string;
  onAddToDeployment: (eui: Uint8Array) => void;
  inDeployment: (eui: Uint8Array) => boolean;
}) {
  const { tags: knownTags, remember } = useKnownTags();
  const reachableTags = useReachableTags(knownTags);
  const unlisted = unlistedNote(knownTags, reachableTags.length);
  const checks = useTagChecks();
  const { downloadedAt } = useDownloaded();
  const now = useNow(15_000);
  const [selected, setSelected] = useState<number[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const liveRanges = useLiveRanges();

  const bluetoothReason = bluetoothTransport().unavailableReason();
  // The helper's list has every tag nearby or plugged in, so neither the browser's USB picker nor the
  // list of tags it knows is needed while the helper runs
  const helperRunning = bluetoothTransport().id === 'helper';
  const serialReason = webSerialTransport.unavailableReason();

  /** Read the tag and keep what it said; returns the reading. */
  const readCheck = useCallback(async (connection: TagConnection) => {
    const snapshot = await connection.readSnapshot();
    const check = assessSnapshot(snapshot, connection.identity.firmware, Date.now() / 1000);
    checks.record(connection.identity.eui, check);
    return check;
  }, [checks]);
  const read = useCallback(async (connection: TagConnection) => { await readCheck(connection); }, [readCheck]);

  const pickNew = useCallback(async (transport: TagTransport) => {
    setError(null);
    setMessage(null);
    void liveRanges.stop();
    setBusy('Reading the tag…');
    try {
      const connection = await transport.requestDevice();
      if (!connection) return;
      try {
        remember(connection.identity);
        setSelected(Array.from(connection.identity.eui));
        await read(connection);
      } finally {
        await connection.disconnect();
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }, [liveRanges.stop, read, remember]);

  const run = useCallback(async (eui: readonly number[], doing: string, action: (connection: TagConnection) => Promise<void>) => {
    setError(null);
    setMessage(null);
    const route = routeTo(knownTags, eui);
    if (!route) { setError(unreachableMessage(eui, route)); return; }
    setBusy(doing);
    try {
      if (!(await withTag(route, action))) setError(unreachableMessage(eui, route));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }, [knownTags]);

  const pickKnown = useCallback((tag: KnownTag) => {
    void liveRanges.stop();
    setSelected([...tag.eui]);
    void run(tag.eui, 'Reading the tag…', read);
  }, [liveRanges.stop, read, run]);

  /** Hold a connection open and show the distances the tag measures as it measures them. */
  const showLiveRanges = useCallback(async (eui: readonly number[]) => {
    setError(null);
    setMessage(null);
    const route = routeTo(knownTags, eui);
    if (!route) { setError(unreachableMessage(eui, route)); return; }
    setBusy('Connecting to the tag…');
    try {
      const connection = await connectTo(route);
      if (!connection) { setError(unreachableMessage(eui, route)); return; }
      if (!connection.liveRadio) {
        await connection.disconnect();
        setError(connection.identity.transport === 'serial'
          ? 'Live ranges come over Bluetooth, which a tag plugged into a computer turns off. Unplug it, put it on its charger, and pick it with "Pick a tag".'
          : "This tag's firmware is too old to send live ranges. Updating its firmware will fix this.");
        return;
      }
      await liveRanges.start(connection);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }, [knownTags, liveRanges.start]);

  const eui = selected ? Uint8Array.from(selected) : null;
  const check = eui ? checks.get(eui) : null;
  const stored = check?.stored ?? null;
  const saved = stored && eui ? downloadedAt(eui[0] ?? 0, stored.startTime) : null;
  const canCancel = !!stored && storedState(stored, now) !== 'cancelled' && storedState(stored, now) !== 'finished';

  return (
    <div className="split split--check">
      <div className="split__main">
        <section className="panel">
          <h2 className="panel__title">Which tag?</h2>
          <p className="panel__note">
            Put the tag on its charger, or plug it into this computer with its USB cable, then pick it.
            Reading it changes nothing on the tag.
          </p>
          <div className="actions">
            <button type="button" className="button" disabled={!!bluetoothReason || !!busy} title={bluetoothReason ?? undefined}
              onClick={() => void pickNew(bluetoothTransport())}>Pick a tag</button>
            {!helperRunning && (
              <button type="button" className="button button--quiet" disabled={!!serialReason || !!busy} title={serialReason ?? undefined}
                onClick={() => void pickNew(webSerialTransport)}>Pick a tag plugged in by USB</button>
            )}
          </div>
          {!helperRunning && reachableTags.length > 0 && (
            <>
              <h3 className="panel__subtitle">Tags used recently</h3>
              <ul className="chips">
                {reachableTags.map((tag) => {
                  const active = selected && formatEui(Uint8Array.from(tag.eui)) === formatEui(Uint8Array.from(selected));
                  return (
                    <li key={tag.handle} className={`chip${active ? ' chip--on' : ''}`}>
                      <button type="button" className="chip__button" disabled={!!busy} onClick={() => pickKnown(tag)}>
                        {describeKnownTag(tag)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {!helperRunning && unlisted && <p className="panel__note">{unlisted}</p>}
          {busy && <p className="banner banner--info" role="status">{busy}</p>}
          {error && <p className="banner banner--crit" role="alert">{error}</p>}
          {message && <p className="banner banner--info" role="status">{message}</p>}
        </section>
      </div>

      <div className="split__side split__side--wide">
        {eui ? (
          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">{tagName(eui)}</h2>
              <span className="panel__count">{formatEui(eui)}</span>
            </div>
            {check ? (
              <TagDetails check={check} now={now} timezone={timezone} downloadedAt={saved} />
            ) : (
              <p className="empty">Not read yet.</p>
            )}
            <div className="actions">
              {/* Each of these connects, acts and disconnects, which would end a stream of live ranges */}
              <button type="button" className="button button--quiet" disabled={!!busy || !!liveRanges.live}
                title={liveRanges.live ? 'Stop the live ranges first' : undefined}
                onClick={() => void run(selected!, 'Reading the tag…', read)}>Check again</button>
              <button type="button" className="button button--quiet" disabled={!!busy || !!liveRanges.live}
                title={liveRanges.live ? 'Stop the live ranges first' : undefined}
                onClick={() => void run(selected!, 'Sounding the buzzer…', async (connection) => {
                  await connection.locate(BUZZ_SECONDS);
                  setMessage(`${tagName(eui)} is buzzing for ${BUZZ_SECONDS} seconds.`);
                })}>Buzz</button>
              {liveRanges.live ? (
                <button type="button" className="button button--quiet" onClick={() => void liveRanges.stop()}>Stop live ranges</button>
              ) : (
                <button type="button" className="button button--quiet" disabled={!!busy}
                  onClick={() => void showLiveRanges(selected!)}>Show live ranges</button>
              )}
              {!inDeployment(eui) && (
                <button type="button" className="button button--quiet" disabled={!!busy}
                  onClick={() => { onAddToDeployment(eui); setMessage(`${tagName(eui)} was added to the deployment being set up.`); }}>
                  Add to the deployment being set up
                </button>
              )}
            </div>
            {liveRanges.live && <LiveRanges live={liveRanges.live} stored={stored} />}
            {canCancel && (
              <div className="danger-zone">
                <h3 className="panel__subtitle">Cancel its deployment</h3>
                <p className="panel__note">
                  For a tag that should no longer take part, such as when a family withdraws. It stops recording and
                  will not start again until a new deployment is written to it.
                </p>
                <ConfirmButton
                  label="Cancel this tag's deployment…"
                  danger
                  disabled={!!busy || !!liveRanges.live}
                  confirmLabel="Cancel the deployment"
                  question={
                    <>
                      Cancel {tagName(eui)}'s deployment?{' '}
                      {mayHoldData(stored, now)
                        ? saved
                          ? 'Its data was saved from this browser, but anything it recorded since then will be out of reach.'
                          : <strong>Anything it has recorded so far will be out of reach of these tools afterwards. Download it first on the Download &amp; review page.</strong>
                        : 'It has not started recording, so no data is lost.'}
                    </>
                  }
                  onConfirm={() => void run(selected!, 'Canceling…', async (connection) => {
                    await connection.cancelDeployment();
                    // Read back rather than trusting it: a tag off its charger refuses without saying so
                    const after = await readCheck(connection);
                    if (after.stored && !after.stored.cancelled) setError(`${tagName(eui)} kept its deployment. ${OFF_CHARGER_HINT}`);
                    else setMessage(`${tagName(eui)}'s deployment was canceled.`);
                  })}
                />
              </div>
            )}
          </section>
        ) : (
          <section className="panel panel--empty">
            <p className="empty">Pick a tag to see its battery, its clock, and the deployment it holds.</p>
          </section>
        )}
      </div>
    </div>
  );
}
