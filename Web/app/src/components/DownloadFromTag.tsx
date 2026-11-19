import { useCallback, useEffect, useState } from 'react';
import { FolderIcon } from './Icons.tsx';
import { describeRate, describeRemaining, extractPageFrames, formatEui, mergeRepairs, tagName,
  NANDLOG_MAX_RETRANSMIT_PAGES, V2_RETRANSMIT_PAGE_ATTEMPTS, V2_RETRANSMIT_RETRY_ROUNDS } from '@tottag/schema';
import { parseLogAsync, releaseLogs } from '../lib/parseAsync.ts';
import { webSerialTransport } from '../adapters/webSerial.ts';
import { describeKnownTag, useKnownTags, type KnownTag } from '../features/useKnownTags.ts';
import { bluetoothTransport, connectTo, errorText, transportFor, unlistedNote, unreachableMessage, useReachableTags } from '../lib/tagAccess.ts';
import type { DownloadProgress, PickOptions, TagConnection, TagTransport } from '../ports/tagTransport.ts';
import type { LoadedLog } from '../ports/logSource.ts';
import type { DownloadFolderState, DownloadOutcome } from '../lib/useLogs.ts';
import type { FolderDeployment } from '../features/folderDeployment.ts';

interface Props {
  /** Open a log just downloaded, and save it into the download folder when there is one. */
  onDownloaded: (log: LoadedLog) => Promise<DownloadOutcome>;
  busy: boolean;
  /** The tags whose logs are open on this page, as `02:31`, which the TotTag Helper's list keeps out of the way. */
  openTags: ReadonlySet<string>;
  /** The folder downloads are saved into; null until one is chosen. */
  folder: DownloadFolderState | null;
  /** The deployment the folder's record describes, whose tags the TotTag Helper's list offers first. */
  folderTags: FolderDeployment | null;
  /** False where the browser cannot be given a folder, so each card's Save button is the way to keep a log. */
  canChooseFolder: boolean;
  onChooseFolder: () => Promise<void>;
  onAllowFolder: () => Promise<void>;
}

/** What one tag's download came to. */
interface Downloaded {
  readonly name: string;
  readonly megabytes: number;
  readonly repaired: number;
  readonly outcome: DownloadOutcome;
}

/**
 * Pulling a log off a tag.
 *
 * The result is the offload stream verbatim — byte for byte what a `.ttg` on disk holds — so it goes
 * through exactly the same reader as an imported file. A live download and a file cannot disagree,
 * because there is only one parser.
 *
 * The tag must be on its charger. That is not a UI nicety: `nandlog` only serves a log in
 * maintenance mode, which the firmware enters when it detects the charger.
 */
export function DownloadFromTag({ onDownloaded, busy, openTags, folder, folderTags, canChooseFolder, onChooseFolder, onAllowFolder }: Props) {
  const { tags: knownTags, remember } = useKnownTags();
  const reachableTags = useReachableTags(knownTags);
  const unlisted = unlistedNote(knownTags, reachableTags.length);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The tag being downloaded, named, and which of several it is. */
  const [current, setCurrent] = useState<string | null>(null);
  /** Downloading, from the pick to the last tag: between tags there is no transfer to show, but it is not over. */
  const [working, setWorking] = useState(false);
  const reason = bluetoothTransport().unavailableReason();

  // Until its stream header, the tag is reading through its whole log to total its size. How long that takes
  // is not known in advance, so the wait counts up rather than pretending to a percentage.
  const calculating = progress !== null && (progress.phase === 'starting' || progress.phase === 'header');
  const [calculatingSince, setCalculatingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!calculating) {
      setCalculatingSince(null);
      return undefined;
    }
    const since = Date.now();
    setCalculatingSince(since);
    setNow(since);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [calculating]);
  const serialReason = webSerialTransport.unavailableReason();
  // The helper's list has every tag nearby or plugged in, so neither the browser's USB picker nor the
  // list of tags it knows is needed while the helper runs
  const helperRunning = bluetoothTransport().id === 'helper';

  /**
   * Download one connected tag's log, ask again for any page that did not survive, and hand the log
   * over to be opened and saved. `step` prefixes what is said meanwhile, for one of several tags.
   */
  const downloadFrom = useCallback(async (connection: TagConnection, step: string): Promise<Downloaded> => {
    const shown = tagName(connection.identity.eui);
    setCurrent(`${step}${shown}`);
    let bytes = await connection.downloadLog(null, setProgress);
    if (bytes.length === 0) throw new Error('The tag sent no data. It has to be on its charger to serve a log.');

    // Ask for whatever did not survive the transfer, up to a fixed number of rounds. Every page the
    // device still holds is one it can simply send again, and the transfer is the only part of this
    // path that loses data -- the flash itself has never lost a byte across any run.
    //
    // Each round MERGES what came back into the stream rather than keeping it alongside, so the
    // bytes that get saved are the repaired ones. A file that still lacks a page the tool went and
    // fetched would report holes on re-import that had already been fixed, and the recovery would
    // survive only in whatever was on screen at the time.
    let repaired = 0;
    const attempts = new Map<number, number>();
    for (let round = 1; round <= V2_RETRANSMIT_RETRY_ROUNDS; ++round) {
      // Read only to find the missing pages; the log's ranging rounds are not wanted from this pass.
      const parsed = await parseLogAsync(bytes, 'download-repair-check');
      releaseLogs(['download-repair-check']);
      const wanted = parsed.missingSeqs;
      // No page at all means there is no sequence number to count from, so there is nothing to
      // name and the whole transfer has to be repeated rather than patched.
      const nothingArrived = !!parsed.report.totalPages && parsed.report.pagesRead === 0;
      if (!wanted.length && !nothingArrived) break;

      // Only pages with attempts left are worth asking for, and only as many as the device can
      // hold. Everything else keeps its own remaining attempts for a later round.
      const askable = wanted.filter((seq) => (attempts.get(seq) ?? 0) < V2_RETRANSMIT_PAGE_ATTEMPTS);
      const batch = askable.slice(0, NANDLOG_MAX_RETRANSMIT_PAGES);
      if (!batch.length && !nothingArrived) break;   // everything still missing has spent its attempts

      setStatus(nothingArrived
        ? `${step}No pages arrived from ${shown}; repeating the download, attempt ${round}…`
        : `${step}Requesting ${batch.length} of ${wanted.length} missing page${wanted.length === 1 ? '' : 's'} from ${shown}, round ${round}…`);

      if (nothingArrived) {
        // A repeated transfer REPLACES what came before rather than patching it.
        bytes = await connection.downloadLog(null, setProgress);
        repaired = 0;
        attempts.clear();
      } else {
        for (const seq of batch) attempts.set(seq, (attempts.get(seq) ?? 0) + 1);
        const frames = extractPageFrames(await connection.retransmitPages(batch, setProgress));
        const merged = mergeRepairs(bytes, frames);
        // A round that recovered nothing is NOT a reason to stop: those pages have each spent one
        // of their own attempts, and the loop ends when they run out rather than on one bad round.
        if (merged !== bytes) {
          repaired += frames.size;
          bytes = merged;
        }
      }
      setProgress(null);
    }
    setProgress(null);
    setStatus(`${step}Saving ${shown}…`);
    const eui = formatEui(connection.identity.eui);
    const outcome = await onDownloaded({
      // A name only for the case where the log carries no details block to derive a better one
      // from; `buildReport` replaces it with what tottag.py would have written. The EUI's low
      // byte is what identifies this device inside that block.
      name: `${eui.replace(/:/g, '')}_${Math.floor(Date.now() / 1000)}.ttg`,
      bytes,
      // Through the TotTag Helper or the browser, either way it came over Bluetooth
      origin: connection.identity.transport === 'serial' ? 'serial' : 'bluetooth',
      deviceUid: connection.identity.eui[0],
    });
    return { name: shown, megabytes: bytes.length / 1e6, repaired, outcome };
  }, [onDownloaded]);

  /** What to say once downloads are over: what was saved where, and what was not. */
  const report = useCallback((done: readonly Downloaded[], failed: readonly string[], picked: number) => {
    const where = folder?.name;
    const unsaved = done.filter((each) => !each.outcome.savedAs);
    const renamed = done.filter((each) => each.outcome.savedAs && each.outcome.report && each.outcome.savedAs !== each.outcome.report.saveName);
    const repaired = done.reduce((sum, each) => sum + each.repaired, 0);
    const said: string[] = [];
    if (done.length === 1 && picked === 1) {
      const [one] = done;
      said.push(`Downloaded ${one!.megabytes.toFixed(2)} MB from ${one!.name}`
        + (repaired ? `, with ${repaired} page${repaired === 1 ? '' : 's'} recovered by asking again` : '')
        + (one!.outcome.savedAs ? `, and saved it in ${where} as ${one!.outcome.savedAs}.` : '.'));
    } else if (done.length) {
      const saved = done.length - unsaved.length;
      said.push(`Downloaded ${done.length === picked ? (picked === 2 ? 'both' : `all ${picked}`) : `${done.length} of the ${picked}`} tags`
        + (saved === done.length && where ? ` and saved them in ${where}.` : '.')
        + (repaired ? ` ${repaired} page${repaired === 1 ? ' was' : 's were'} recovered by asking again.` : ''));
    }
    for (const each of renamed) said.push(`${each.name} was saved as ${each.outcome.savedAs}, since a file named ${each.outcome.report!.saveName} was already there.`);
    for (const each of unsaved) {
      said.push(each.outcome.saveError
        ? `${each.name} could not be saved in ${where}: ${each.outcome.saveError} Save it from its card below.`
        : `${each.name} is not on your computer yet: save it from its card below.`);
    }
    setStatus(said.length ? said.join(' ') : null);
    setError(failed.length
      ? (picked > 1 ? `Could not download ${failed.length} of the ${picked} tags. ` : '') + failed.join(' ')
      : null);
  }, [folder?.name]);

  const fromNew = useCallback(async (transport: TagTransport) => {
    setError(null);
    setStatus(null);
    setProgress(null);
    const done: Downloaded[] = [];
    const failed: string[] = [];
    // Only a tag on its charger serves its log; and a folder kept for one deployment is most likely being filled from its tags
    const options: PickOptions = {
      done: { ids: openTags, label: 'Already downloaded' },
      chargingOnly: true,
      ...(folderTags ? { expected: folderTags } : {}),
    };
    let picked = 0;
    setWorking(true);
    try {
      if (transport.requestDevices) {
        // Several at once, from the TotTag Helper's list, downloaded one after another and each saved as it arrives
        const tags = transport.requestDevices((count) => {
          picked = count;
          setStatus(`Connecting to ${count === 1 ? 'the tag' : `the first of ${count} tags`}…`);
        }, options);
        for (let index = 1; ; index += 1) {
          const step = await tags.next();
          if (step.done) break;
          if (step.value instanceof Error) {
            failed.push(step.value.message);
          } else {
            const connection = step.value;
            remember(connection.identity);
            try {
              setStatus(null);
              done.push(await downloadFrom(connection, picked > 1 ? `Tag ${index} of ${picked}: ` : ''));
            } catch (caught) {
              failed.push(`${tagName(connection.identity.eui)}: ${errorText(caught)}`);
            } finally {
              setProgress(null);
              setCurrent(null);
              await connection.disconnect();
            }
          }
          if (index < picked) setStatus(`Connecting to tag ${index + 1} of ${picked}…`);
        }
      } else {
        // Use the connection the chooser just returned rather than dropping it and reconnecting. The
        // round trip through getDevices() was what produced "could not reach that tag" for a tag the
        // user had only just picked, on any Chrome where that API is still behind a flag.
        const connection = await transport.requestDevice(() => setStatus('Connecting to the tag…'), options);
        setStatus(null);
        if (!connection) return;   // dismissed
        picked = 1;
        remember(connection.identity);
        try {
          done.push(await downloadFrom(connection, ''));
        } catch (caught) {
          failed.push(errorText(caught));
        } finally {
          await connection.disconnect();
        }
      }
    } catch (caught) {
      failed.push(errorText(caught));
    } finally {
      setProgress(null);
      setCurrent(null);
      setWorking(false);
    }
    if (picked || failed.length) report(done, failed, Math.max(picked, 1));
  }, [downloadFrom, folderTags, openTags, remember, report]);

  const fromKnown = useCallback(async (tag: KnownTag) => {
    setError(null);
    setProgress(null);
    setStatus('Connecting to the tag…');
    setWorking(true);
    let connection: TagConnection | null = null;
    try {
      connection = await connectTo(tag);
      setStatus(null);
      if (!connection) { setError(unreachableMessage(tag.eui, tag)); return; }
      report([await downloadFrom(connection, '')], [], 1);
    } catch (caught) {
      report([], [errorText(caught)], 1);
    } finally {
      await connection?.disconnect();
      setProgress(null);
      setCurrent(null);
      setWorking(false);
    }
  }, [downloadFrom, report]);

  // Downloads go straight into a folder wherever the browser can be given one
  const folderReason = !canChooseFolder ? null
    : !folder ? 'Choose the folder to save downloads into first.'
      : !folder.writable ? `Allow saving into ${folder.name} first.` : null;

  if (reason && serialReason) {
    return (
      <section className="panel">
        <h2 className="panel__title">Download from a tag</h2>
        <p className="banner banner--warn">{reason}</p>
      </section>
    );
  }

  const active = progress !== null || working;
  return (
    <section className="panel">
      <h2 className="panel__title">Download from a tag</h2>
      <p className="panel__note">
        Put the tag on its charger first (it only hands over its data while charging), or plug it into this
        computer with its USB cable. A download takes a few minutes.
      </p>
      {canChooseFolder && (
        <div className="save-to">
          <span className="save-to__label">Save downloads to</span>
          {folder ? (
            <>
              <span className="save-to__folder"><FolderIcon /> {folder.name}</span>
              {!folder.writable && (
                <button type="button" className="button button--small" onClick={() => void onAllowFolder()} disabled={active}>
                  Allow saving here
                </button>
              )}
              <button type="button" className="link" onClick={() => void onChooseFolder()} disabled={active}>Change folder</button>
            </>
          ) : (
            <button type="button" className="button button--small" onClick={() => void onChooseFolder()}>Choose a folder</button>
          )}
          <p className="save-to__note">
            {!folder ? 'Each log is saved there the moment it arrives. A deployment record (.json) in the folder is opened too.'
              : !folder.writable ? 'This browser needs your permission again to save into this folder.'
                : 'Each log is saved here the moment it arrives, beside any already there.'}
          </p>
        </div>
      )}
      <div className="actions">
        <button type="button" className="button" onClick={() => void fromNew(bluetoothTransport())}
          disabled={!!reason || !!folderReason || busy || active} title={reason ?? folderReason ?? undefined}>
          {helperRunning ? 'Download from tags' : 'Download from a tag'}
        </button>
        {!helperRunning && (
          <button type="button" className="button button--quiet" onClick={() => void fromNew(webSerialTransport)}
            disabled={!!serialReason || !!folderReason || busy || active} title={serialReason ?? folderReason ?? undefined}>
            Download from a tag plugged in by USB
          </button>
        )}
      </div>
      {!helperRunning && reachableTags.length > 0 && (
        <>
          <h3 className="panel__subtitle">Or download from a tag used recently</h3>
          <ul className="chips">
            {reachableTags.map((tag) => (
              <li key={tag.handle} className="chip">
                <button type="button" className="chip__button" onClick={() => void fromKnown(tag)}
                  disabled={busy || active || !!folderReason || !!transportFor(tag).unavailableReason()}>
                  {describeKnownTag(tag)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!helperRunning && unlisted && <p className="panel__note">{unlisted}</p>}

      {progress && (
        <div className="transfer">
          {current && <p className="transfer__text transfer__text--name">{current}</p>}
          {calculating ? (
            <>
              <div className="transfer__bar"><div className="transfer__fill transfer__fill--busy" /></div>
              <p className="transfer__text">
                Calculating data size…
                {calculatingSince !== null && ` (${describeElapsed(Math.floor((now - calculatingSince) / 1000))})`}
              </p>
            </>
          ) : (
            <>
              <div className="transfer__bar">
                <div className="transfer__fill"
                  style={{ width: `${progress.bytesExpected ? Math.min(100, (progress.bytesReceived / progress.bytesExpected) * 100) : 3}%` }} />
              </div>
              <p className="transfer__text">
                {(progress.bytesReceived / 1e6).toFixed(2)} MB
                {progress.bytesExpected ? ` of ${(progress.bytesExpected / 1e6).toFixed(2)} MB` : ''}
                {' · '}{describeRate(progress.bytesPerSecond)}
                {' · '}{describeRemaining(progress.secondsRemaining)}
              </p>
            </>
          )}
        </div>
      )}
      {status && <p className="banner banner--info" role="status">{status}</p>}
      {error && <p className="banner banner--crit" role="alert">{error}</p>}
    </section>
  );
}

/** Whole seconds as "12 s", or "2 min 05 s" past a minute. */
function describeElapsed(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
