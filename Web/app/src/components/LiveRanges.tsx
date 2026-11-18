// The distances one tag measures, streamed to this page as it measures them.
//
// The tag sends one notification per ranging round to a host that has subscribed, and only while it is
// ranging: off its charger in a running deployment, or in a radio test. A tag on its charger is not
// ranging, so it sends nothing, which the panel says rather than showing an empty table.

import { useCallback, useEffect, useRef, useState } from 'react';
import { shownLabel, tagName } from '@tottag/schema';
import type { StoredDeployment } from '../features/tagStatus.ts';
import { toUnit } from '../features/units.ts';
import { useNow } from '../lib/useNow.ts';
import type { TagConnection } from '../ports/tagTransport.ts';

interface Reading {
  readonly mm: number;
  /** Unix seconds it arrived. */
  readonly at: number;
}

export interface LiveRangesState {
  /** The latest distance to each tag the streaming one has ranged to, by one-byte ID. */
  readonly readings: ReadonlyMap<number, Reading>;
  /** A report arrived cut short of its own count, so a tag may be missing. */
  readonly truncated: boolean;
}

interface Session {
  readonly connection: TagConnection;
  stopWatching: (() => Promise<void>) | null;
  stopListening: () => void;
}

/**
 * Streaming one tag's ranges, started and stopped from a click.
 *
 * Started and stopped by the caller rather than by an effect, because React runs an effect's cleanup
 * and setup again in development, and a cleanup that let go of the connection would end the stream it
 * was about to restart. Stopping unsubscribes, then disconnects; so does the page going away.
 */
export function useLiveRanges() {
  const [live, setLive] = useState<LiveRangesState | null>(null);
  const active = useRef<Session | null>(null);

  const stop = useCallback(async () => {
    const session = active.current;
    active.current = null;
    setLive(null);
    if (!session) return;
    session.stopListening();
    try { await session.stopWatching?.(); } catch { /* already gone */ }
    await session.connection.disconnect();
  }, []);

  /**
   * Stream `connection`'s ranges, which must have a live radio link. If the connection closes, whether the tag
   * dropped it or another page used the tag and let it go, the stream simply ends.
   */
  const start = useCallback(async (connection: TagConnection) => {
    const link = connection.liveRadio;
    if (!link) throw new Error("This tag's firmware is too old to send live ranges. Updating its firmware will fix this.");
    await stop();
    const session: Session = { connection, stopWatching: null, stopListening: () => {} };
    active.current = session;
    setLive({ readings: new Map(), truncated: false });
    session.stopListening = link.onDisconnect(() => {
      if (active.current !== session) return;
      active.current = null;
      setLive(null);
    });
    try {
      session.stopWatching = await link.watchRanges((ranges, cut) => {
        if (active.current !== session) return;
        const at = Date.now() / 1000;
        setLive((previous) => {
          if (!previous) return previous;
          const readings = new Map(previous.readings);
          for (const [uid, mm] of ranges) readings.set(uid, { mm, at });
          return { readings, truncated: previous.truncated || cut };
        });
      });
    } catch (error) {
      if (active.current === session) {
        await stop();
      } else {
        session.stopListening();
        await connection.disconnect();
      }
      throw error;
    }
  }, [stop]);

  useEffect(() => () => { void stop(); }, [stop]);

  return { live, start, stop };
}

/** What to call a tag the streaming one ranged to: by the deployment it holds, or by its one-byte ID. */
function peerName(uid: number, stored: StoredDeployment | null): string {
  const device = stored?.devices.find((candidate) => candidate.eui[0] === uid);
  if (!device) return `A tag ending ${uid.toString(16).padStart(2, '0').toUpperCase()}`;
  const label = shownLabel(device.label, device.eui);
  return label ? `${label} (${tagName(device.eui)})` : tagName(device.eui);
}

const distance = (mm: number) => `${toUnit(mm, 'ft').toFixed(1)} ft · ${toUnit(mm, 'm').toFixed(2)} m`;

/** The latest distance to each tag, as they arrive. */
export function LiveRanges({ live, stored }: { live: LiveRangesState; stored: StoredDeployment | null }) {
  const now = useNow(1000);
  const rows = [...live.readings]
    .map(([uid, reading]) => ({ uid, name: peerName(uid, stored), ...reading }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="live-ranges">
      <h3 className="panel__subtitle">Live ranges</h3>
      {rows.length === 0 ? (
        <p className="panel__note" role="status">
          Waiting for ranges. A tag sends them only while it is ranging: off its charger, in a running deployment,
          with other tags from that deployment nearby.
        </p>
      ) : (
        <table className="rtable">
          <thead>
            <tr><th>To</th><th>Distance</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.uid}>
                <td>{row.name}</td>
                <td>{distance(row.mm)}</td>
                <td>{now - row.at < 2 ? 'just now' : `${Math.round(now - row.at)} s ago`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {live.truncated && (
        <p className="banner banner--warn">
          Some reports arrived cut short, because this computer's Bluetooth negotiated small packets, so a tag may be
          missing from the list.
        </p>
      )}
    </div>
  );
}
