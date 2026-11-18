// The tags the TotTag Helper has found, nearby and plugged in, to pick from in place of the browser's
// Bluetooth chooser and USB port picker: several at once where a page adds tags, one where it works
// on one.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { shortAddress, tagName } from '@tottag/schema';
import { setTagPicker, type PickedTag } from '../adapters/helperTransport.ts';
import { helperUsb, type PluggedTag } from '../adapters/helperUsb.ts';
import { addressInName, nameMatches } from '../features/tagNames.ts';
import { helper, type ScannedTag } from '../lib/helper.ts';
import type { PickOptions } from '../ports/tagTransport.ts';

interface Asking extends PickOptions {
  readonly multiple: boolean;
  readonly resolve: (picked: PickedTag[]) => void;
}

/** Mounted once, in App: shows the list whenever a page asks the helper for tags. */
export function TagPickerHost() {
  const [asking, setAsking] = useState<Asking | null>(null);
  useEffect(() => {
    setTagPicker((options) => new Promise<PickedTag[]>((resolve) => setAsking({ ...options, resolve })));
    return () => setTagPicker(null);
  }, []);
  if (!asking) return null;
  const done = (picked: PickedTag[]) => {
    asking.resolve(picked);
    setAsking(null);
  };
  return <TagPicker options={asking} onDone={done} />;
}

/** How strong a tag's signal is, in words, because a number in dBm means nothing to most people. */
const signalWords = (rssi: number) => (rssi >= -60 ? 'Strong signal' : rssi >= -75 ? 'Good signal' : 'Weak signal');

/** Why a tag plugged in cannot be picked yet, or null when it can. */
const notYet = (tag: PluggedTag): string | null => {
  switch (tag.state) {
    case 'ready': return null;
    case 'identifying': return 'Asking which tag it is…';
    case 'busy': return 'Another program is using it';
    case 'silent': return 'Its firmware is too old to say which tag it is';
  }
};

/** One row of the list: a tag to pick, or one that cannot be picked and why. */
interface Row {
  readonly key: string;
  readonly pick: PickedTag | null;
  readonly name: string;
  readonly detail: string;
  readonly title?: string;
  /** The last two parts of its address, `02:31`, when its name says them. */
  readonly id: string | null;
}

const pluggedRow = (tag: PluggedTag): Row => {
  const why = notYet(tag);
  return {
    key: `usb:${tag.port}`,
    pick: why ? null : { kind: 'usb', port: tag.port },
    name: tag.eui && !why ? tagName(tag.eui) : 'A tag plugged in by USB',
    detail: why ?? 'Plugged in by USB',
    title: tag.port,
    id: tag.eui && !why ? shortAddress(tag.eui) : null,
  };
};

const nearbyRow = (tag: ScannedTag): Row => ({
  key: `ble:${tag.id}`,
  pick: { kind: 'bluetooth', device: tag.id },
  name: tag.name,
  detail: signalWords(tag.rssi),
  title: `${tag.rssi} dBm`,
  // Firmware older than `TotTag 02:31` names says less, and such a tag is never taken for one already done
  id: addressInName(tag.name),
});

function TagPicker({ options, onDone }: { options: Asking; onDone: (picked: PickedTag[]) => void }) {
  const { multiple, done } = options;
  const usb = options.usb ?? true;
  const { scanning, nearby } = useSyncExternalStore(helper.subscribe, helper.getSnapshot);
  const plugged = useSyncExternalStore(helperUsb.subscribe, helperUsb.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const startedScan = useRef(false);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    // Scan while the list is open, unless something else already is; and stop what this started
    if (!helper.getSnapshot().scanning) {
      startedScan.current = true;
      helper.startScan().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    }
    // And look at the USB ports while it is open, for tags plugged in
    const stopWatching = usb ? helperUsb.watch() : null;
    return () => {
      element?.close();
      stopWatching?.();
      if (startedScan.current) {
        startedScan.current = false;
        void helper.stopScan().catch(() => undefined);
      }
    };
  }, [usb]);

  const isDone = (row: Row) => !!done && !!row.id && done.ids.has(row.id);
  const wanted = /[0-9a-z]/i.test(search);
  // A tag searched for is shown even if it is done with: whoever typed its name means it
  const shown = (row: Row) => (wanted ? nameMatches(row.name, search) : !isDone(row) || showDone);
  // Plugged in first: plugging a tag in is a plain statement of which tag is meant. Tags done with go last.
  const order = (rows: Row[]) => [...rows.filter((row) => !isDone(row)), ...rows.filter(isDone)];
  const all = [
    { title: 'Plugged into this computer', rows: usb ? order(plugged.map(pluggedRow)) : [] },
    { title: 'Nearby', rows: order(nearby.map(nearbyRow)) },
  ];
  const groups = all.map((group) => ({ ...group, rows: group.rows.filter(shown) })).filter((group) => group.rows.length);
  const rows = groups.flatMap((group) => group.rows);
  const everyRow = all.flatMap((group) => group.rows);
  const hiddenDone = wanted || showDone ? 0 : everyRow.filter(isDone).length;
  const pickable = rows.filter((row) => row.pick);
  const toggle = (key: string) =>
    setChosen((current) => (current.includes(key) ? current.filter((each) => each !== key) : [...current, key]));
  // Only what is still in the list: a tag that has gone out of range or been unplugged since it was ticked cannot be reached
  const picked = everyRow.filter((row) => row.pick && chosen.includes(row.key)).map((row) => row.pick!);
  const detailOf = (row: Row) => (isDone(row) ? `${done!.label} · ${row.detail}` : row.detail);

  return (
    <dialog ref={dialog} className="picker" aria-labelledby="picker-title"
      onCancel={(event) => { event.preventDefault(); onDone([]); }}>
      <h2 id="picker-title" className="panel__title">{multiple ? 'Add tags' : 'Pick a tag'}</h2>
      <p className="panel__note" role="status">
        {scanning
          ? `Looking for tags nearby. A tag shows up while it is on its charger or recording${usb ? ', or plugged into this computer with its USB cable' : ''}.`
          : 'The tags the last scan found.'}
      </p>
      <input type="search" className="input" placeholder="Find a tag, such as 02:31" aria-label="Find a tag"
        value={search} onChange={(event) => setSearch(event.target.value)} />
      {rows.length === 0 ? (
        <p className="empty">
          {wanted ? `No tag found matches “${search.trim()}”.`
            : hiddenDone ? 'Every tag found so far is one already done.'
              : scanning ? 'None found yet.' : 'None found.'}
        </p>
      ) : groups.map((group) => (
        <section key={group.title}>
          {groups.length > 1 && <h3 className="panel__subtitle">{group.title}</h3>}
          <ul className="picker__list">
            {group.rows.map((row) => (
              <li key={row.key}>
                {!row.pick ? (
                  <div className="picker__row picker__row--off" title={row.title}>
                    <span className="picker__name">{row.name}</span>
                    <span className="picker__signal">{row.detail}</span>
                  </div>
                ) : multiple ? (
                  <label className={`picker__row${isDone(row) ? ' picker__row--done' : ''}`} title={row.title}>
                    <input type="checkbox" checked={chosen.includes(row.key)} onChange={() => toggle(row.key)} />
                    <span className="picker__name">{row.name}</span>
                    <span className="picker__signal">{detailOf(row)}</span>
                  </label>
                ) : (
                  <button type="button" className={`picker__row${isDone(row) ? ' picker__row--done' : ''}`} title={row.title}
                    onClick={() => onDone([row.pick!])}>
                    <span className="picker__name">{row.name}</span>
                    <span className="picker__signal">{detailOf(row)}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {done && (hiddenDone > 0 || (showDone && !wanted)) && (
        <p className="panel__note">
          {showDone
            ? <button type="button" className="link" onClick={() => setShowDone(false)}>Hide the tags {done.label.toLowerCase()}</button>
            : <>{hiddenDone === 1 ? 'One tag' : `${hiddenDone} tags`} {done.label.toLowerCase()} {hiddenDone === 1 ? 'is' : 'are'} not listed.{' '}
              <button type="button" className="link" onClick={() => setShowDone(true)}>Show {hiddenDone === 1 ? 'it' : 'them'}</button></>}
        </p>
      )}
      {error && <p className="banner banner--crit" role="alert">{error}</p>}
      <div className="actions">
        {multiple && (
          <>
            <button type="button" className="button" disabled={!picked.length} onClick={() => onDone(picked)}>
              {picked.length ? `Add ${picked.length} tag${picked.length === 1 ? '' : 's'}` : 'Add tags'}
            </button>
            {pickable.length > 1 && (
              <button type="button" className="button button--quiet"
                onClick={() => setChosen((current) => [...new Set([...current, ...pickable.map((row) => row.key)])])}>
                {wanted ? 'Select all shown' : 'Select all'}
              </button>
            )}
          </>
        )}
        <button type="button" className="button button--quiet" onClick={() => onDone([])}>Cancel</button>
      </div>
    </dialog>
  );
}
