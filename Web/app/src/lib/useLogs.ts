// The logs open in this page: imported from disk or downloaded from tags. Shared by the review page
// and the radio check, so held by the app shell.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { identifyRadioLog } from '@tottag/schema';
import { downloadBytes, downloadText } from '../adapters/download.ts';
import {
  allowWriting, canChooseFolder, canWrite, chooseFolder, folderRecords, rememberedFolder, writeNew, type FolderHandle,
} from '../adapters/downloadFolder.ts';
import { directoryLogSource } from '../adapters/fileLogSource.ts';
import { buildReport, sortByUrgency, type DeviceReport } from '../features/deployment.ts';
import { summaryCsv, summaryFilename } from '../features/exportCsv.ts';
import { readRecordFiles, type OpenRecord } from '../features/studyClock.ts';
import { useDownloaded } from '../features/useTagRecords.ts';
import type { LoadedLog, LoadFailure, LoadResult } from '../ports/logSource.ts';
import { releaseLogs } from './parseAsync.ts';
import { folderDeployment, type FolderDeployment } from '../features/folderDeployment.ts';

export type LogsApi = ReturnType<typeof useLogs>;

/** The folder downloads are saved into, as the page shows it. */
export interface DownloadFolderState {
  readonly name: string;
  /** False after a reload until the browser is asked again whether the page may write there. */
  readonly writable: boolean;
}

/** What became of one download: where it was saved, or why it was not. */
export interface DownloadOutcome {
  readonly report: DeviceReport | null;
  /** The file name written into the download folder. */
  readonly savedAs: string | null;
  readonly saveError: string | null;
}

export function useLogs() {
  const [reports, setReports] = useState<readonly DeviceReport[]>([]);
  const [failures, setFailures] = useState<readonly LoadFailure[]>([]);
  // Deployment records opened with the logs: where each deployment's time zone comes from. Kept for this
  // visit only, like the logs, and never written to storage: they carry one study's labels.
  const [records, setRecords] = useState<readonly OpenRecord[]>([]);
  const recordsRef = useRef<readonly OpenRecord[]>([]);
  const [busy, setBusy] = useState(false);
  // Ids of logs whose bytes have been written to disk at least once. Only meaningful for logs that
  // came off a tag; an imported file is on disk by definition.
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  // Index counter kept outside state: onLoaded must not close over a stale reports array.
  const reportCount = useRef(0);
  const { markDownloaded } = useDownloaded();

  /** Remember that this deployment's data is safely on disk, so its tags can be set up again without a second warning. */
  const noteOnDisk = useCallback((report: DeviceReport) => {
    const start = report.radio?.experimentStartTime;
    const uid = report.radio ? identifyRadioLog(report.radio, report.name, report.deviceUid) : null;
    if (uid !== null && start) markDownloaded(uid, start);
  }, [markDownloaded]);

  const onLoaded = useCallback(async (result: LoadResult): Promise<DeviceReport[]> => {
    setBusy(true);
    try {
      // Parsed in a worker, so a multi-megabyte deployment file does not freeze the page. Sequential
      // rather than parallel: one worker handles them in turn, and a dozen files racing for it would
      // only make the first one slower.
      const built: DeviceReport[] = [];
      for (const [index, log] of result.loaded.entries()) {
        built.push(await buildReport(log, reportCount.current + index));
      }
      reportCount.current += built.length;
      for (const report of built) if (report.origin === 'file' && !report.error) noteOnDisk(report);
      const recordFiles = readRecordFiles(result.records ?? [], recordsRef.current, result.fromFolder);
      if (recordFiles.added.length) {
        recordsRef.current = [...recordsRef.current, ...recordFiles.added];
        setRecords(recordsRef.current);
      }
      setReports((current) => [...current, ...built]);
      setFailures([...result.failed, ...recordFiles.failed]);
      return built;
    } finally {
      setBusy(false);
    }
  }, [noteOnDisk]);

  // --- The folder downloads are saved into --------------------------------------------------------

  const folderRef = useRef<FolderHandle | null>(null);
  const [folder, setFolder] = useState<DownloadFolderState | null>(null);
  // The deployment the folder's newest record describes, whose tags the list to download from offers first
  const [folderTags, setFolderTags] = useState<FolderDeployment | null>(null);

  /** Open the deployment records in the folder, which give its logs their time zone and labels. */
  const openFolderRecords = useCallback(async (handle: FolderHandle) => {
    const records = await folderRecords(handle);
    setFolderTags(folderDeployment(records));
    if (records.length) await onLoaded({ loaded: [], failed: [], records, fromFolder: true });
  }, [onLoaded]);

  // The folder chosen on an earlier visit, if the browser still has it
  useEffect(() => {
    let live = true;
    void (async () => {
      const handle = await rememberedFolder();
      if (!handle || !live) return;
      const writable = await canWrite(handle);
      if (!live) return;
      folderRef.current = handle;
      setFolder({ name: handle.name, writable });
      if (writable) await openFolderRecords(handle);
    })();
    return () => { live = false; };
  }, [openFolderRecords]);

  /** Choose the folder downloads are saved into. From a click. */
  const chooseDownloadFolder = useCallback(async () => {
    setSaveError(null);
    try {
      const handle = await chooseFolder();
      if (!handle) return;
      folderRef.current = handle;
      setFolder({ name: handle.name, writable: true });
      setFolderTags(null);
      await openFolderRecords(handle);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [openFolderRecords]);

  /** Ask again to write into the folder chosen on an earlier visit. From a click. */
  const allowDownloadFolder = useCallback(async () => {
    const handle = folderRef.current;
    if (!handle) return;
    const writable = await allowWriting(handle);
    setFolder({ name: handle.name, writable });
    if (writable) await openFolderRecords(handle);
  }, [openFolderRecords]);

  /**
   * A log just downloaded from a tag: opened like any other, and written into the download folder at
   * once, under the name its card would save it as.
   */
  const addDownload = useCallback(async (log: LoadedLog): Promise<DownloadOutcome> => {
    const [report] = await onLoaded({ loaded: [log], failed: [] });
    const handle = folderRef.current;
    if (!report?.data || !handle) return { report: report ?? null, savedAs: null, saveError: null };
    try {
      const savedAs = await writeNew(handle, report.saveName, report.data);
      setSaved((current) => new Set(current).add(report.id));
      if (!report.error) noteOnDisk(report);
      return { report, savedAs, saveError: null };
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      // Permission can be withdrawn while the page is open; the folder then has to be allowed again
      if (!(await canWrite(handle))) setFolder({ name: handle.name, writable: false });
      return { report, savedAs: null, saveError: reason };
    }
  }, [noteOnDisk, onLoaded]);

  const ordered = useMemo(() => sortByUrgency(reports), [reports]);
  const counts = useMemo(() => {
    const tally = { ok: 0, note: 0, warning: 0, error: 0 };
    for (const report of reports) tally[report.status] += 1;
    return tally;
  }, [reports]);
  const unsaved = useMemo(
    () => reports.filter((report) => report.data !== null && !saved.has(report.id)),
    [reports, saved],
  );

  // The one thing this app can destroy. Bytes pulled off a tag exist nowhere else, a transfer costs
  // minutes, and a closed tab takes them with it silently. The browser's own dialog is generic and
  // cannot be reworded, but it is the only thing that fires before the page is gone.
  useEffect(() => {
    if (unsaved.length === 0) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';   // still required by browsers that predate preventDefault() here
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved.length]);

  const exportCsv = useCallback(() => {
    void downloadText(summaryFilename(new Date()), summaryCsv(ordered));
  }, [ordered]);

  const saveLog = useCallback(async (report: DeviceReport) => {
    if (!report.data) return;
    setSaveError(null);
    try {
      // Only on a real write. A dismissed save dialog must leave the log counted as unsaved, or the
      // warning and the disabled Clear — the two things standing between a cancelled save and lost
      // bytes — would both quietly go away.
      if (await downloadBytes(report.saveName, report.data)) {
        setSaved((current) => new Set(current).add(report.id));
        if (!report.error) noteOnDisk(report);
      }
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [noteOnDisk]);

  const openFolder = useCallback(async () => {
    await onLoaded(await directoryLogSource.load());
  }, [onLoaded]);

  const clear = useCallback(() => {
    // The worker holds every log's ranging rounds; closing the logs lets them go.
    releaseLogs('all');
    setReports([]);
    recordsRef.current = [];
    setRecords([]);
    setFailures([]);
    setSaved(new Set());
    setSaveError(null);
  }, []);

  return {
    reports, ordered, counts, failures, records, busy, saved, unsaved, saveError, onLoaded, exportCsv, saveLog, openFolder, clear,
    folder, folderTags, canChooseDownloadFolder: canChooseFolder(), chooseDownloadFolder, allowDownloadFolder, addDownload,
  };
}
