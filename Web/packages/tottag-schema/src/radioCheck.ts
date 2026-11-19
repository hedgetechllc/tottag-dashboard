// Radio health across a set of devices, each judged against the others.
//
// The test this supports is a bench run: devices ranging where they can all hear each other for a few minutes,
// compared with each other. The data comes either from their logs, where the RANGES records say which peers a
// device heard and at what distance and the diagnostics record says how many ranging receives failed, or live
// over Bluetooth (liveRadio.ts), which also splits the receives by antenna. Logs do not carry that split, so a
// check run from logs judges each device's receiver but not its antennas one by one. A device whose receiver or
// antenna is damaged stands out against the others, because the others sat in the same room at the same time.
//
// Two halves, because the app parses each log in a worker and only small results come back:
//   - summarizeRadio() runs beside the parser and reduces one log to per-minute counts and distances. A live
//     recording (liveRadio.ts) bins every 15 seconds instead, so its verdicts move as the test goes.
//   - analyseRadio() runs on the page over the summaries of every device in the deployment.

import { SCHEDULING_INTERVAL_US } from './constants.ts';
import { fileLabel, legacyFileLabel } from './deployment.ts';
import { parseExperimentDetails, type ParseResult } from './log.ts';

/** How long each bin of a summary made from a log covers. */
export const LOG_BIN_MS = 60_000;

/** Ranging rounds in one minute. */
export const ROUNDS_PER_MINUTE = (60_000_000 / SCHEDULING_INTERVAL_US);

/** Ranging rounds in one bin of the given length, which participation and link coverage are measured against. */
export const roundsPerBin = (binMs: number) => (binMs * 1000) / SCHEDULING_INTERVAL_US;

/** Least time every device must have run together for its ranging to be judged at all. */
export const MIN_JUDGED_MS = 60_000;

// --- Thresholds --------------------------------------------------------------------------------------
//
// Comparisons are against the MEDIAN OF THE OTHER DEVICES, not of all of them, so that in a three-device test
// one bad device cannot drag the yardstick towards itself. Absolute floors catch a fleet that is bad as a
// whole, which no relative test can.

/** Fraction of rounds a device must produce a range in. A healthy network manages about 0.99. */
export const PARTICIPATION_FAIL = 0.5;
export const PARTICIPATION_CHECK = 0.85;
/** Failed-receive rate above the other devices' median that warrants a look, and that indicates a fault. */
export const RX_FAILURE_CHECK_EXCESS = 0.08;
export const RX_FAILURE_FAIL_EXCESS = 0.2;
/** Gap between a device's best and worst antenna. Each round cycles all three, so they should match. */
export const ANTENNA_CHECK_SPREAD = 0.1;
export const ANTENNA_FAIL_SPREAD = 0.25;
/** Receives an antenna needs before its rate means anything. */
export const ANTENNA_MIN_SAMPLES = 200;
/** Share of each other's receives two tags must decode, both ways and on every antenna, to be the others' yardstick. */
export const REFERENCE_LINK_SUCCESS = 0.95;
/** Measured distance under which two tags are too close to judge: 2 feet, less ranging error. */
export const TOO_CLOSE_MM = 500;
/** Shown first, and every verdict is unknown, when no two devices are shown healthy to judge the others by. */
export const NO_REFERENCE_NOTE = `No two tags decoded at least ${Math.round(REFERENCE_LINK_SUCCESS * 100)}% of each other's ranging both ways, so none can be ` +
  'shown healthy to judge the others by, and every verdict is Unknown. The figures shown are each tag\'s own counts. Include at least two tags known to be good.';
/** A device's typical link coverage, below the others' typical coverage, or outright. */
export const COVERAGE_CHECK_DROP = 0.15;
export const COVERAGE_FAIL = 0.5;
/** Systematic distance error of one device, with known positions. */
export const BIAS_CHECK_MM = 120;
export const BIAS_FAIL_MM = 300;
/** Distance spread, relative to the other devices and in absolute terms. */
export const NOISE_CHECK_FACTOR = 2;
export const NOISE_CHECK_MIN_MM = 50;
/** Rounds lost to a receive that could not be armed in time, as a fraction of rounds. */
export const ARM_LATE_CHECK = 0.01;

// --- Per-log summary ---------------------------------------------------------------------------------

/** Radio counters summed over every boot in the log. */
export interface RadioDiagnosticsTotals {
  readonly rxOk: number;
  readonly rxFailed: number;
  readonly rxOkByAntenna: readonly number[];
  readonly rxFailedByAntenna: readonly number[];
  readonly wakeFailures: number;
  readonly irqStuck: number;
  readonly rxArmLate: number;
  readonly txLate: number;
  /** Diagnostics records the totals came from. */
  readonly samples: number;
  /**
   * The receive counts again, split by sender, where the device reports them: a live test, on firmware whose radio
   * statistics carry them. Absent from every log.
   */
  readonly bySender?: readonly SenderCounts[];
}

/** One device's receives from one sender, per antenna, since it booted. */
export interface SenderCounts {
  /** The sender, by the low byte of its EUI. */
  readonly uid: number;
  readonly rxOkByAntenna: readonly number[];
  readonly rxFailedByAntenna: readonly number[];
}

/** One bin of ranges to one peer: [bin, ranges, median mm, median absolute deviation mm]. */
export type PeerBin = readonly [number, number, number, number];

/**
 * What one device's log says about its radio, reduced to something small enough to pass out of a worker.
 *
 * Everything is binned by experiment time so that analyseRadio() can restrict every device to the same
 * stretch of time without the raw records, which for a long deployment run to millions of ranges. Bin n covers
 * [n * binMs, (n + 1) * binMs) of experiment time.
 */
export interface RadioSummary {
  /** Unix seconds the deployment started, from the details block, or null for a log without one. */
  readonly experimentStartTime: number | null;
  /** Low EUI byte of every device the deployment selected, in the order it lists them. */
  readonly deploymentUids: readonly number[];
  readonly deploymentLabels: readonly string[];
  /**
   * Which device wrote this log, when the log itself settles it: the one selected device it never ranged to.
   * Null when that is ambiguous, as it is for a device that ranged to nobody.
   */
  readonly selfUid: number | null;
  /** Experiment-relative span of every record, which is when the device was running and logging. */
  readonly firstMs: number | null;
  readonly lastMs: number | null;
  /** How long each bin covers: LOG_BIN_MS for a log, LIVE_BIN_MS for a live recording. */
  readonly binMs: number;
  /** [bin, RANGES records] for every bin that had any. */
  readonly rowsByBin: ReadonlyArray<readonly [number, number]>;
  readonly peers: ReadonlyArray<{ readonly uid: number; readonly bins: readonly PeerBin[] }>;
  readonly diagnostics: RadioDiagnosticsTotals | null;
  /** RADIO_ABORT records, which only a diagnostic build writes. */
  readonly aborts: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Reduce one parsed log to its radio summary. */
export function summarizeRadio(result: ParseResult): RadioSummary {
  const details = result.report.details && result.report.details.length >= 18
    ? parseExperimentDetails(result.report.details) : null;
  const deploymentUids = details ? details.uids.map((uid) => uid[0]!) : [];

  let firstMs: number | null = null;
  let lastMs: number | null = null;
  const rows = new Map<number, number>();
  const peerBins = new Map<number, PeerBin[]>();
  // Records arrive in page order, which is time order but for the odd clock step, so each minute is
  // finalised when the next one starts; a minute that recurs after a step simply gets a second entry.
  const open = new Map<number, { minute: number; values: number[] }>();
  const close = (uid: number) => {
    const bucket = open.get(uid);
    if (!bucket || !bucket.values.length) return;
    const centre = median(bucket.values);
    const spread = median(bucket.values.map((value) => Math.abs(value - centre)));
    if (!peerBins.has(uid)) peerBins.set(uid, []);
    peerBins.get(uid)!.push([bucket.minute, bucket.values.length, centre, spread]);
    open.delete(uid);
  };

  let totals = { rxOk: 0, rxFailed: 0, wakeFailures: 0, irqStuck: 0, rxArmLate: 0, txLate: 0, samples: 0 };
  let pending: Extract<ParseResult['records'][number], { kind: 'diagnostics' }> | null = null;
  // The counters are cumulative since boot, so a boot contributes its LAST record. A reset record ends a
  // boot; so does a counter going backwards, for a reset whose record never reached flash.
  const settle = () => {
    if (!pending) return;
    totals = {
      rxOk: totals.rxOk + pending.radioRxOk,
      rxFailed: totals.rxFailed + pending.radioRxFailed,
      wakeFailures: totals.wakeFailures + pending.radioWakeFailures,
      irqStuck: totals.irqStuck + pending.radioIrqStuck,
      rxArmLate: totals.rxArmLate + pending.radioRxArmLate,
      txLate: totals.txLate + pending.radioTxLate,
      samples: totals.samples,
    };
    pending = null;
  };

  let aborts = 0;
  const seenPeers = new Set<number>();
  for (const record of result.records) {
    firstMs = firstMs === null ? record.ms : Math.min(firstMs, record.ms);
    lastMs = lastMs === null ? record.ms : Math.max(lastMs, record.ms);
    if (record.kind === 'ranges') {
      const minute = Math.floor(record.ms / LOG_BIN_MS);
      rows.set(minute, (rows.get(minute) ?? 0) + 1);
      for (const [uid, millimetres] of record.ranges) {
        seenPeers.add(uid);
        const bucket = open.get(uid);
        if (bucket && bucket.minute !== minute) close(uid);
        if (!open.has(uid)) open.set(uid, { minute, values: [] });
        open.get(uid)!.values.push(millimetres);
      }
    } else if (record.kind === 'diagnostics') {
      if (pending && record.radioRxOk < pending.radioRxOk) settle();
      pending = record;
      totals = { ...totals, samples: totals.samples + 1 };
    } else if (record.kind === 'reset') {
      settle();
    } else if (record.kind === 'radioAbort') {
      aborts += 1;
    }
  }
  for (const uid of [...open.keys()]) close(uid);
  settle();

  const unseen = deploymentUids.filter((uid) => !seenPeers.has(uid));
  return {
    experimentStartTime: details ? details.experimentStartTime : null,
    deploymentUids,
    deploymentLabels: details ? [...details.labels] : [],
    selfUid: unseen.length === 1 ? unseen[0]! : null,
    firstMs,
    lastMs,
    binMs: LOG_BIN_MS,
    rowsByBin: [...rows].sort((a, b) => a[0] - b[0]),
    peers: [...peerBins].map(([uid, bins]) => ({ uid, bins })),
    diagnostics: totals.samples
      ? { ...totals, rxOkByAntenna: [], rxFailedByAntenna: [] }
      : null,
    aborts,
  };
}

// --- Cross-device analysis ----------------------------------------------------------------------------

/** Unknown where no two devices are shown healthy, so there is nothing to judge a device against. */
export type RadioVerdict = 'pass' | 'check' | 'fail' | 'missing' | 'unknown';

export interface RadioCheckDevice {
  readonly uid: number;
  readonly label: string;
  readonly verdict: RadioVerdict;
  /** Plain-language reasons for anything but a pass, worst first; for an unknown verdict, what its own counts show. */
  readonly reasons: readonly string[];
  /** Fraction of the test's rounds in which this device produced a range. */
  readonly participation: number | null;
  /** Ranging receives that failed, over the whole log. */
  readonly rxFailureRate: number | null;
  /** The same, per antenna; null for an antenna with too few receives to judge. */
  readonly antennaFailureRates: ReadonlyArray<number | null>;
  /** Median, over this device's links to the healthy devices (or to all, where none is shown healthy), of the fraction of rounds it ranged to that peer. */
  readonly linkCoverage: number | null;
  /** Systematic distance error, mm, solved from known positions. Null without them. */
  readonly biasMm: number | null;
  /** Typical distance spread on the same links as its coverage, mm. */
  readonly noiseMm: number | null;
  readonly diagnostics: RadioDiagnosticsTotals | null;
  readonly aborts: number;
  /** How well it hears and is heard with its partners allowed for, where every device reports receives by sender. */
  readonly quality?: TagQuality;
}

export interface RadioCheckLink {
  readonly a: number;
  readonly b: number;
  /** Fraction of the test's rounds in which `a` logged a range to `b`, and the reverse. */
  readonly coverageAtoB: number;
  readonly coverageBtoA: number;
  readonly medianMm: number | null;
  readonly noiseMm: number | null;
  /** From the positions entered, when both devices have one. */
  readonly trueMm: number | null;
  readonly residualMm: number | null;
}

export interface RadioCheckResult {
  /** The stretch every loaded device was running for, in experiment ms [start, end), in whole bins. */
  readonly windowStartMs: number | null;
  readonly windowEndMs: number | null;
  readonly devices: readonly RadioCheckDevice[];
  readonly links: readonly RadioCheckLink[];
  /** Things that limit what the check can say, for the page to show above the results. */
  readonly notes: readonly string[];
  /** Every device's receives from every other, where every device reports them by sender. */
  readonly receptions?: readonly Reception[];
  /** The devices shown healthy that the others were measured against, with receptions; empty when none was. */
  readonly references?: readonly number[];
}

// --- Telling a tag that hears poorly from one the others cannot hear -----------------------------------------------
//
// A receive fails as much for a sender transmitting weakly as for a receiver hearing poorly, and every device uses
// the same antenna at the same time, so a device with a damaged antenna raises every other device's failures on that
// antenna too: with two bad tags in five, half of what each good tag listens to comes from a bad one. Counted by
// sender, the two can be told apart. The chance that receiver r decodes sender t is modelled as hears(r) × heard(t),
// both fitted from every pair at once by iterative proportional fitting, which keeps each device's decodes as a
// receiver and as a sender at their counted totals. A device is then judged by its own factor, whoever it was tested
// with. The fit ranks the devices, but a pairing that fails for its own reasons, such as a null in one device's damaged
// antenna pointing at another, leaks into both devices' factors and can make a healthy device look weak. So it is only
// the first pass: each device is then measured directly against the devices shown healthy, hears(r) as the share of
// what they sent that r decoded, heard(t) as the share of what t sent that they decoded.
//
// The fit cannot say how good the best device is, only how the others compare with it, so healthy is shown absolutely:
// a link is no better than either end, so two tags that decode each other at least REFERENCE_LINK_SUCCESS of the time,
// both ways and on every antenna, are both healthy. Where no pair does, no tag is shown healthy, and each is measured
// against all the others instead.

/** One device's receives from another, per antenna. */
export interface Reception {
  readonly receiver: number;
  readonly sender: number;
  readonly rxOk: readonly number[];
  readonly rxFailed: readonly number[];
}

export interface TagQuality {
  /** Share of what the devices with nothing wrong with them sent that this one decoded; null on too few receives to judge. */
  readonly hears: number | null;
  /** Share of what this device sent that the devices with nothing wrong with them decoded; null likewise. */
  readonly heard: number | null;
  /** The same through each antenna alone. */
  readonly hearsByAntenna: ReadonlyArray<number | null>;
  readonly heardByAntenna: ReadonlyArray<number | null>;
}

interface Cell { readonly receiver: number; readonly sender: number; readonly ok: number; readonly total: number }

/** hears and heard for every device, from the cells of one antenna or of all of them together. */
function fitQualities(uids: readonly number[], cells: readonly Cell[]): Map<number, { hears: number | null; heard: number | null }> {
  const hears = new Map(uids.map((uid) => [uid, 1]));
  const heard = new Map(uids.map((uid) => [uid, 1]));
  const asReceiver = new Map(uids.map((uid) => [uid, cells.filter((cell) => cell.receiver === uid)]));
  const asSender = new Map(uids.map((uid) => [uid, cells.filter((cell) => cell.sender === uid)]));
  const update = (factors: Map<number, number>, groups: Map<number, Cell[]>, partner: (cell: Cell) => number) => {
    let change = 0;
    for (const [uid, group] of groups) {
      const expected = group.reduce((sum, cell) => sum + cell.total * partner(cell), 0);
      if (expected <= 0) continue;
      const next = group.reduce((sum, cell) => sum + cell.ok, 0) / expected;
      change = Math.max(change, Math.abs(next - factors.get(uid)!));
      factors.set(uid, next);
    }
    return change;
  };
  for (let round = 0; round < 1000; round += 1) {
    const changed = update(hears, asReceiver, (cell) => heard.get(cell.sender)!) + update(heard, asSender, (cell) => hears.get(cell.receiver)!);
    if (changed < 1e-10) break;
  }
  const samples = (group: Cell[]) => group.reduce((sum, cell) => sum + cell.total, 0);
  const judged = (groups: Map<number, Cell[]>) => uids.filter((uid) => samples(groups.get(uid)!) >= ANTENNA_MIN_SAMPLES);
  const bestHears = Math.max(0, ...judged(asReceiver).map((uid) => hears.get(uid)!));
  const bestHeard = Math.max(0, ...judged(asSender).map((uid) => heard.get(uid)!));
  return new Map(uids.map((uid) => [uid, {
    hears: samples(asReceiver.get(uid)!) >= ANTENNA_MIN_SAMPLES ? Math.min(1, hears.get(uid)! * bestHeard) : null,
    heard: samples(asSender.get(uid)!) >= ANTENNA_MIN_SAMPLES ? Math.min(1, heard.get(uid)! * bestHears) : null,
  }]));
}

/** Each device's hearing and being heard, and the devices shown healthy that they were measured against. */
export interface SeparatedReceptions {
  readonly qualities: Map<number, TagQuality>;
  /** Devices in a pair that decoded each other at least REFERENCE_LINK_SUCCESS of the time; empty when none did. */
  readonly references: readonly number[];
}

/** How well each device hears and is heard, overall and through each antenna, with its partners allowed for. */
export function separateReceptions(uids: readonly number[], receptions: readonly Reception[]): SeparatedReceptions {
  const within = receptions.filter((r) => r.receiver !== r.sender && uids.includes(r.receiver) && uids.includes(r.sender));
  const antennas = Math.max(0, ...within.map((r) => r.rxOk.length));
  const cellsFor = (antenna: number | null): Cell[] => within.map((r) => {
    const ok = antenna === null ? r.rxOk.reduce((a, b) => a + b, 0) : r.rxOk[antenna] ?? 0;
    const failed = antenna === null ? r.rxFailed.reduce((a, b) => a + b, 0) : r.rxFailed[antenna] ?? 0;
    return { receiver: r.receiver, sender: r.sender, ok, total: ok + failed };
  });
  // The model holds antenna by antenna, every device being on the same one at once, but not for counts pooled across
  // them; so a device's overall figure is the mean of its antennas', each carrying an equal share of the rounds. The
  // pooled fit stands in only where no antenna alone has enough receives to judge.
  const pooled = fitQualities(uids, cellsFor(null));
  const perAntenna = Array.from({ length: antennas }, (_, antenna) => fitQualities(uids, cellsFor(antenna)));
  const mean = (values: ReadonlyArray<number | null>, fallback: number | null) => {
    const judged = values.filter((value): value is number => value !== null);
    return judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : fallback;
  };
  const fitted = new Map(uids.map((uid) => {
    const hearsByAntenna = perAntenna.map((fit) => fit.get(uid)!.hears);
    const heardByAntenna = perAntenna.map((fit) => fit.get(uid)!.heard);
    return [uid, {
      hears: mean(hearsByAntenna, pooled.get(uid)!.hears), heard: mean(heardByAntenna, pooled.get(uid)!.heard),
      hearsByAntenna, heardByAntenna,
    }];
  }));

  // Second pass: each device measured directly against the devices shown healthy, or against every other where none is
  const share = (cells: readonly Cell[]) => {
    const total = cells.reduce((sum, cell) => sum + cell.total, 0);
    return total >= ANTENNA_MIN_SAMPLES ? cells.reduce((sum, cell) => sum + cell.ok, 0) / total : null;
  };
  const pooledCells = cellsFor(null);
  const antennaCells = Array.from({ length: antennas }, (_, antenna) => cellsFor(antenna));
  const measure = (references: ReadonlySet<number>) => new Map(uids.map((uid) => {
    const fit = fitted.get(uid)!;
    const from = (cells: readonly Cell[]) => cells.filter((cell) => cell.receiver === uid && references.has(cell.sender));
    const by = (cells: readonly Cell[]) => cells.filter((cell) => cell.sender === uid && references.has(cell.receiver));
    // A device with no clean partner to be measured against keeps what the fit made of it
    const hearing = from(pooledCells).length > 0;
    const heardBy = by(pooledCells).length > 0;
    const hearsByAntenna = hearing ? antennaCells.map((cells) => share(from(cells))) : fit.hearsByAntenna;
    const heardByAntenna = heardBy ? antennaCells.map((cells) => share(by(cells))) : fit.heardByAntenna;
    return [uid, {
      hears: hearing ? mean(hearsByAntenna, share(from(pooledCells))) : fit.hears,
      heard: heardBy ? mean(heardByAntenna, share(by(pooledCells))) : fit.heard,
      hearsByAntenna, heardByAntenna,
    }];
  }));
  // One way of a pair, on all antennas together (which must have the receives to judge) or on one (which need not)
  const reaches = (cells: readonly Cell[], receiver: number, sender: number, required: boolean) => {
    const cell = cells.find((c) => c.receiver === receiver && c.sender === sender);
    if (!cell || cell.total < ANTENNA_MIN_SAMPLES) return !required;
    return cell.ok / cell.total >= REFERENCE_LINK_SUCCESS;
  };
  const healthy = new Set<number>();
  uids.forEach((a, i) => uids.slice(i + 1).forEach((b) => {
    const pooledBoth = reaches(pooledCells, a, b, true) && reaches(pooledCells, b, a, true);
    if (pooledBoth && antennaCells.every((cells) => reaches(cells, a, b, false) && reaches(cells, b, a, false))) {
      healthy.add(a);
      healthy.add(b);
    }
  }));
  return { qualities: measure(healthy.size ? healthy : new Set(uids)), references: uids.filter((uid) => healthy.has(uid)) };
}

export interface RadioCheckInput {
  /** Every device the deployment selected, with its log's summary where one was loaded. */
  readonly devices: ReadonlyArray<{ readonly uid: number; readonly label: string; readonly summary: RadioSummary | null }>;
  /** Known positions in metres, by device, for whichever devices have them. */
  readonly positions?: ReadonlyMap<number, { readonly x: number; readonly y: number }>;
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** What a device's own receiving and transmitting say about it, against the best device's, or against perfection where no device is shown healthy. */
function judgeQuality(quality: TagQuality, bestHears: number, bestHeard: number, referenced: boolean): { fails: string[]; checks: string[] } {
  const fails: string[] = [];
  const checks: string[] = [];
  const judge = (excess: number, message: string, failMessage: string, failAt: number, checkAt: number) => {
    if (excess > failAt) fails.push(`${message} ${failMessage}`);
    else if (excess > checkAt) checks.push(message);
  };
  const partners = referenced ? 'the healthy tags' : 'the other tags';
  if (quality.hears !== null) {
    judge(bestHears - quality.hears,
      referenced
        ? `${percent(1 - quality.hears)} of its receives from the healthy tags failed, against ${percent(1 - bestHears)} for the tag that hears best.`
        : `${percent(1 - quality.hears)} of its receives failed.`,
      'A weak receiver, a damaged antenna or connection, or something nearby transmitting over it.',
      RX_FAILURE_FAIL_EXCESS, RX_FAILURE_CHECK_EXCESS);
  }
  if (quality.heard !== null) {
    judge(bestHeard - quality.heard,
      referenced
        ? `The healthy tags failed to receive ${percent(1 - quality.heard)} of what it sent, against ${percent(1 - bestHeard)} for the tag heard best.`
        : `The other tags failed to receive ${percent(1 - quality.heard)} of what it sent.`,
      'A weak transmitter, or a damaged antenna or connection.',
      RX_FAILURE_FAIL_EXCESS, RX_FAILURE_CHECK_EXCESS);
  }
  // Every antenna well behind its best, receiving or sending: the same damage shows both ways, and two can be damaged
  for (const receiving of [true, false]) {
    const misses = (receiving ? quality.hearsByAntenna : quality.heardByAntenna)
      .map((share, antenna) => [antenna, share === null ? null : 1 - share] as const)
      .filter((entry): entry is readonly [number, number] => entry[1] !== null);
    if (misses.length < 2) continue;
    const best = misses.reduce((x, y) => (y[1] < x[1] ? y : x));
    const behind = misses.filter((entry) => entry[1] - best[1] > ANTENNA_CHECK_SPREAD);
    if (!behind.length) continue;
    const rest = misses.filter((entry) => !behind.includes(entry));
    const numbers = listed(behind.map((entry) => `${entry[0] + 1}`));
    const which = `${behind.length === 1 ? 'antenna' : 'antennas'} ${numbers}`;
    const failed = listed(behind.map((entry) => percent(entry[1])));
    const against = rest.length === 1 ? `${percent(rest[0]![1])} through antenna ${rest[0]![0] + 1}` : `${listed(rest.map((entry) => percent(entry[1])))} through the others`;
    const message = receiving
      ? `${which[0]!.toUpperCase()}${which.slice(1)} failed ${failed} of its receives${referenced ? ' from the healthy tags' : ''}, against ${against}.`
      : `${partners[0]!.toUpperCase()}${partners.slice(1)} failed to receive ${failed} of what it sent through ${which}, against ${against}.`;
    if (behind.some((entry) => entry[1] - best[1] > ANTENNA_FAIL_SPREAD)) {
      fails.push(`${message} ${behind.length === 1 ? 'That antenna, its switch, or its connection is suspect.' : 'Those antennas, their switch, or their connections are suspect.'}`);
    } else {
      checks.push(message);
    }
  }
  return { fails, checks };
}

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Least-squares per-device offsets from link residuals: residual(a, b) ~ bias(a) + bias(b). */
function solveBiases(uids: readonly number[], residuals: ReadonlyArray<readonly [number, number, number]>): Map<number, number> | null {
  const index = new Map(uids.map((uid, i) => [uid, i]));
  const n = uids.length;
  if (n < 3 || residuals.length < n) return null;
  const matrix = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const [a, b, residual] of residuals) {
    const i = index.get(a)!;
    const j = index.get(b)!;
    matrix[i]![i]! += 1; matrix[j]![j]! += 1;
    matrix[i]![j]! += 1; matrix[j]![i]! += 1;
    matrix[i]![n]! += residual; matrix[j]![n]! += residual;
  }
  // Gaussian elimination with partial pivoting; a near-zero pivot means the links cannot separate the
  // devices' offsets (two devices alone, or a layout with no triangle), and then no answer is better than one
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(matrix[row]![col]!) > Math.abs(matrix[pivot]![col]!)) pivot = row;
    if (Math.abs(matrix[pivot]![col]!) < 1e-9) return null;
    [matrix[col], matrix[pivot]] = [matrix[pivot]!, matrix[col]!];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = matrix[row]![col]! / matrix[col]![col]!;
      for (let k = col; k <= n; k += 1) matrix[row]![k]! -= factor * matrix[col]![k]!;
    }
  }
  return new Map(uids.map((uid, i) => [uid, matrix[i]![n]! / matrix[i]![i]!]));
}

/** Judge every device a deployment selected against the others. */
export function analyseRadio(input: RadioCheckInput): RadioCheckResult {
  const notes: string[] = [];
  const loaded = input.devices.filter((device) => device.summary && device.summary.firstMs !== null && device.summary.lastMs !== null);
  const missing = input.devices.length - loaded.length;
  if (missing) notes.push(`${missing} of the ${input.devices.length} selected tags ${missing === 1 ? 'has' : 'have'} no log loaded, so ${missing === 1 ? 'it is' : 'they are'} not judged and ${missing === 1 ? 'its' : 'their'} links are missing from the others.`);

  // The stretch every loaded device was on, in whole bins, so no device is penalised for rounds it was off for. Every
  // summary in one check comes from the same source, logs or a live test, so they share a bin length.
  const binMs = loaded[0]?.summary!.binMs ?? LOG_BIN_MS;
  const start = loaded.length ? Math.max(...loaded.map((d) => Math.ceil(d.summary!.firstMs! / binMs))) : null;
  const end = loaded.length ? Math.min(...loaded.map((d) => Math.floor(d.summary!.lastMs! / binMs))) : null;
  const bins = start !== null && end !== null ? Math.max(0, end - start) : 0;
  const rounds = bins * roundsPerBin(binMs);
  if (loaded.length && bins * binMs < MIN_JUDGED_MS) notes.push('The tags were running together for less than a minute, which is too short to judge ranging. Run the test for at least two minutes.');
  if (loaded.length && loaded.length < 3) notes.push('With fewer than three tags there is no "rest of the fleet" to compare against, so only absolute limits apply, and distance offsets cannot be pinned to a single tag.');
  const inWindow = (bin: number) => start !== null && end !== null && bin >= start && bin < end;

  // Per-link evidence from both ends. Shares here and below stop at 100%: a live test's counts are estimates, and
  // rounding at the window's edges can carry one a round past it.
  const coverage = new Map<string, number>();
  const linkBins = new Map<string, PeerBin[]>();
  const key = (a: number, b: number) => `${a}:${b}`;
  const pair = (a: number, b: number) => (a < b ? key(a, b) : key(b, a));
  for (const device of loaded) {
    for (const peer of device.summary!.peers) {
      const within = peer.bins.filter((m) => inWindow(m[0]));
      coverage.set(key(device.uid, peer.uid), rounds ? Math.min(1, within.reduce((sum, m) => sum + m[1], 0) / rounds) : 0);
      const both = pair(device.uid, peer.uid);
      linkBins.set(both, [...(linkBins.get(both) ?? []), ...within]);
    }
  }

  const positions = input.positions ?? new Map();
  const links: RadioCheckLink[] = [];
  const uids = input.devices.map((device) => device.uid);
  for (let i = 0; i < uids.length; i += 1) {
    for (let j = i + 1; j < uids.length; j += 1) {
      const a = uids[i]!;
      const b = uids[j]!;
      const evidence = linkBins.get(pair(a, b)) ?? [];
      const medianMm = evidence.length ? median(evidence.map((m) => m[2])) : null;
      // Median absolute deviation scaled to a standard deviation, which ignores the occasional wild range
      const noiseMm = evidence.length ? median(evidence.map((m) => m[3])) * 1.4826 : null;
      const pa = positions.get(a);
      const pb = positions.get(b);
      const trueMm = pa && pb ? Math.hypot(pa.x - pb.x, pa.y - pb.y) * 1000 : null;
      links.push({
        a, b,
        coverageAtoB: coverage.get(key(a, b)) ?? 0,
        coverageBtoA: coverage.get(key(b, a)) ?? 0,
        medianMm, noiseMm, trueMm,
        residualMm: medianMm !== null && trueMm !== null ? medianMm - trueMm : null,
      });
    }
  }

  const withResiduals = links.filter((link) => link.residualMm !== null);
  const biases = withResiduals.length
    ? solveBiases([...new Set(withResiduals.flatMap((link) => [link.a, link.b]))], withResiduals.map((link) => [link.a, link.b, link.residualMm!] as const))
    : null;
  if (positions.size && !biases) notes.push('The positions entered do not let each tag\'s distance offset be told apart — it needs at least three tags with positions and ranges between them.');
  if (!positions.size) notes.push('No positions entered, so distances are checked for consistency only. Enter where each tag sat to check accuracy as well.');
  const tooClose = links.filter((link) => link.medianMm !== null && link.medianMm < TOO_CLOSE_MM).sort((x, y) => x.medianMm! - y.medianMm!);
  if (tooClose.length) {
    const label = (uid: number) => input.devices.find((device) => device.uid === uid)!.label;
    const closest = tooClose[0]!;
    const cm = Math.max(0, Math.round(closest.medianMm! / 10));
    notes.push(`${tooClose.length === 1 ? `${label(closest.a)} and ${label(closest.b)} measured about ${cm} cm apart.`
      : `${tooClose.length} pairs of tags measured closer than 2 feet, the closest ${label(closest.a)} and ${label(closest.b)} at about ${cm} cm.`} ` +
      'Place every tag at least 2 feet (60 cm) from every other: tags this close reach each other even with damaged antennas, so the check can pass a tag it should fail.');
  }

  // Receives by sender, where every device loaded reports them: then each device's own receiving and transmitting can
  // be told from its partners', and those replace the raw receive failures, which a bad partner inflates
  const receptions: Reception[] | null = loaded.length >= 2 && loaded.every((device) => device.summary!.diagnostics?.bySender)
    ? loaded.flatMap((device) => device.summary!.diagnostics!.bySender!.map((counts) => ({
        receiver: device.uid, sender: counts.uid, rxOk: counts.rxOkByAntenna, rxFailed: counts.rxFailedByAntenna,
      })))
    : null;
  const separation = receptions?.length ? separateReceptions(loaded.map((device) => device.uid), receptions) : null;
  const qualities = separation?.qualities ?? null;
  const referenced = !!separation?.references.length;
  const unknown = !!separation && !referenced;
  if (unknown) notes.unshift(NO_REFERENCE_NOTE);
  // Links judged only to the healthy devices where some are shown healthy, since a bad partner drags a link down too
  const references = new Set(separation?.references ?? []);
  const judgedWith = (other: number) => !referenced || references.has(other);

  // Each device's own figures
  const figures = new Map(input.devices.map((device) => {
    const summary = device.summary;
    const isLoaded = loaded.includes(device);
    const rows = isLoaded ? summary!.rowsByBin.filter((m) => inWindow(m[0])).reduce((sum, m) => sum + m[1], 0) : 0;
    const diagnostics = summary?.diagnostics ?? null;
    const rxTotal = diagnostics ? diagnostics.rxOk + diagnostics.rxFailed : 0;
    const antennaFailureRates = diagnostics
      ? diagnostics.rxOkByAntenna.map((ok, antenna) => {
          const total = ok + diagnostics.rxFailedByAntenna[antenna]!;
          return total >= ANTENNA_MIN_SAMPLES ? diagnostics.rxFailedByAntenna[antenna]! / total : null;
        })
      : [];
    const mine = links.filter((link) => (link.a === device.uid && judgedWith(link.b)) || (link.b === device.uid && judgedWith(link.a)));
    const myCoverage = mine.map((link) => (link.a === device.uid ? link.coverageAtoB : link.coverageBtoA));
    const myNoise = mine.map((link) => link.noiseMm).filter((noise): noise is number => noise !== null);
    return [device.uid, {
      isLoaded,
      participation: isLoaded && rounds ? Math.min(1, rows / rounds) : null,
      rxFailureRate: rxTotal ? diagnostics!.rxFailed / rxTotal : null,
      antennaFailureRates,
      linkCoverage: isLoaded && myCoverage.length ? median(myCoverage) : null,
      noiseMm: myNoise.length ? median(myNoise) : null,
    }] as const;
  }));

  // Against the best device where some are shown healthy, and against perfection where none is
  const bestOf = (pick: (quality: TagQuality) => number | null) => !referenced ? 1 :
    Math.max(0, ...[...(qualities?.values() ?? [])].map(pick).filter((value): value is number => value !== null));
  const bestHears = bestOf((quality) => quality.hears);
  const bestHeard = bestOf((quality) => quality.heard);

  const othersMedian = (uid: number, pick: (f: typeof figures extends Map<number, infer F> ? F : never) => number | null) => {
    const values = [...figures].filter(([other, f]) => other !== uid && f.isLoaded).map(([, f]) => pick(f)).filter((v): v is number => v !== null);
    return values.length ? median(values) : null;
  };

  const devices: RadioCheckDevice[] = input.devices.map((device) => {
    const f = figures.get(device.uid)!;
    const diagnostics = device.summary?.diagnostics ?? null;
    if (!f.isLoaded) {
      return {
        uid: device.uid, label: device.label, verdict: 'missing', reasons: ['No log loaded for this tag.'],
        participation: null, rxFailureRate: null, antennaFailureRates: [], linkCoverage: null,
        biasMm: null, noiseMm: null, diagnostics: null, aborts: 0,
      };
    }
    const fails: string[] = [];
    const checks: string[] = [];

    if (f.participation !== null && rounds) {
      if (f.participation < PARTICIPATION_FAIL) fails.push(`Ranged in only ${percent(f.participation)} of rounds. It was not taking part in the network for most of the test.`);
      else if (f.participation < PARTICIPATION_CHECK) checks.push(`Ranged in ${percent(f.participation)} of rounds, where a healthy network manages about 99%.`);
    }

    // Judged by its factors where it has any; a device too little heard, or hearing too little, falls back to its raw counts
    const separated = qualities?.get(device.uid);
    const quality = separated && (separated.hears !== null || separated.heard !== null) ? separated : undefined;
    if (quality) {
      const judged = judgeQuality(quality, bestHears, bestHeard, referenced);
      fails.push(...judged.fails);
      checks.push(...judged.checks);
    }

    const rxOthers = othersMedian(device.uid, (g) => g.rxFailureRate);
    if (!quality && f.rxFailureRate !== null) {
      const baseline = rxOthers ?? 0;
      const excess = f.rxFailureRate - baseline;
      const versus = rxOthers !== null ? ` against ${percent(rxOthers)} for the other tags` : '';
      if (excess > RX_FAILURE_FAIL_EXCESS) fails.push(`${percent(f.rxFailureRate)} of its ranging receives failed${versus}. A weak receiver or a damaged antenna or connection.`);
      else if (excess > RX_FAILURE_CHECK_EXCESS) checks.push(`${percent(f.rxFailureRate)} of its ranging receives failed${versus}.`);
    }

    const rates = f.antennaFailureRates.map((rate, antenna) => [antenna, rate] as const).filter((entry): entry is readonly [number, number] => entry[1] !== null);
    if (!quality && rates.length >= 2) {
      const worst = rates.reduce((x, y) => (y[1] > x[1] ? y : x));
      const best = rates.reduce((x, y) => (y[1] < x[1] ? y : x));
      const spread = worst[1] - best[1];
      const others = rates.filter((entry) => entry[0] !== worst[0]).map((entry) => percent(entry[1])).join(' and ');
      const message = `Antenna ${worst[0] + 1} failed ${percent(worst[1])} of the receives through it, against ${others} on the others.`;
      if (spread > ANTENNA_FAIL_SPREAD) fails.push(`${message} That antenna, its switch, or its connection is suspect.`);
      else if (spread > ANTENNA_CHECK_SPREAD) checks.push(message);
    }

    const coverageOthers = othersMedian(device.uid, (g) => g.linkCoverage);
    if (f.linkCoverage !== null && rounds) {
      const peer = referenced ? 'healthy tag' : 'peer';
      if (f.linkCoverage < COVERAGE_FAIL) fails.push(`Ranged to a typical ${peer} in only ${percent(f.linkCoverage)} of rounds.`);
      else if (coverageOthers !== null && f.linkCoverage < coverageOthers - COVERAGE_CHECK_DROP) checks.push(`Ranged to a typical ${peer} in ${percent(f.linkCoverage)} of rounds, against ${percent(coverageOthers)} for the other tags.`);
    }

    const biasMm = biases?.get(device.uid) ?? null;
    if (biasMm !== null) {
      const direction = biasMm > 0 ? 'long' : 'short';
      const message = `Reads about ${Math.round(Math.abs(biasMm))} mm ${direction} on every link. Its antenna delay calibration is off, or its antenna is damaged.`;
      if (Math.abs(biasMm) > BIAS_FAIL_MM) fails.push(message);
      else if (Math.abs(biasMm) > BIAS_CHECK_MM) checks.push(message);
    }

    const noiseOthers = othersMedian(device.uid, (g) => g.noiseMm);
    if (f.noiseMm !== null && noiseOthers !== null && f.noiseMm > NOISE_CHECK_MIN_MM && f.noiseMm > NOISE_CHECK_FACTOR * noiseOthers) {
      checks.push(`Its distances${referenced ? ' to the healthy tags' : ''} spread by about ${Math.round(f.noiseMm)} mm, against ${Math.round(noiseOthers)} mm for the other tags.`);
    }

    if (diagnostics) {
      const recoveries = diagnostics.wakeFailures + diagnostics.irqStuck;
      if (recoveries) checks.push(`The radio needed resetting ${recoveries} time${recoveries === 1 ? '' : 's'} (${diagnostics.wakeFailures} failed wake-up${diagnostics.wakeFailures === 1 ? '' : 's'}, ${diagnostics.irqStuck} stuck interrupt${diagnostics.irqStuck === 1 ? '' : 's'}).`);
      if (rounds && diagnostics.rxArmLate / rounds > ARM_LATE_CHECK) checks.push(`Lost ${diagnostics.rxArmLate} rounds to a receive it could not start in time. That points to firmware timing, not this tag's radio.`);
    }

    return {
      uid: device.uid, label: device.label,
      verdict: unknown ? 'unknown' : fails.length ? 'fail' : checks.length ? 'check' : 'pass',
      reasons: [...fails, ...checks],
      participation: f.participation, rxFailureRate: f.rxFailureRate, antennaFailureRates: f.antennaFailureRates,
      linkCoverage: f.linkCoverage, biasMm, noiseMm: f.noiseMm, diagnostics, aborts: device.summary!.aborts,
      ...(quality ? { quality } : {}),
    };
  });

  return {
    windowStartMs: start === null ? null : start * binMs, windowEndMs: end === null ? null : end * binMs, devices, links, notes,
    ...(receptions?.length ? { receptions, references: separation!.references } : {}),
  };
}

// --- Matching logs to devices -------------------------------------------------------------------------

/**
 * Which selected device a log belongs to.
 *
 * The log usually settles it (the one selected device it never ranged to); failing that, a live download
 * knows the device it came from, and a saved file is named after its device's label or short ID.
 */
export function identifyRadioLog(
  summary: RadioSummary,
  name: string,
  deviceUid?: number,
): number | null {
  if (summary.selfUid !== null) return summary.selfUid;
  if (deviceUid !== undefined && summary.deploymentUids.includes(deviceUid)) return deviceUid;
  // A saved log is `{label}_{start}.ttg`, its label as fileLabel leaves it, so the label may itself contain an
  // underscore. Files saved before a colon became a dash have it dropped instead (legacyFileLabel).
  const base = name.replace(/\.[^.]*$/, '');
  const stems = [base.replace(/_\d+$/, ''), base.split('_')[0]!].map((stem) => stem.trim().toLowerCase());
  const byLabel = summary.deploymentLabels.findIndex((label) =>
    [label.trim(), fileLabel(label), legacyFileLabel(label)].some((candidate) => candidate && stems.includes(candidate.toLowerCase())));
  if (byLabel >= 0) return summary.deploymentUids[byLabel] ?? null;
  // A tag whose label is stored empty is saved under the last two parts of its address, `02-31` (logStem); the
  // second is its one-byte ID. Downloads before that named it by the one-byte ID in decimal, `49` for 0x31, so
  // digits alone are read as decimal first; a stem with a hex letter in it, such as `0B`, can only be hexadecimal.
  const stem = stems[1]!;
  const pair = /^[0-9a-f]{2}-([0-9a-f]{2})$/.exec(stem);
  const candidates = pair ? [Number.parseInt(pair[1]!, 16)] : [
    ...(/^\d{1,3}$/.test(stem) ? [Number.parseInt(stem, 10)] : []),
    ...(/^[0-9a-f]{1,2}$/.test(stem) ? [Number.parseInt(stem, 16)] : []),
  ];
  return candidates.find((uid) => summary.deploymentUids.includes(uid)) ?? null;
}

/** A key that is the same for every log of one deployment and different across deployments. */
export function radioDeploymentKey(summary: RadioSummary): string | null {
  if (summary.experimentStartTime === null || !summary.deploymentUids.length) return null;
  return `${summary.experimentStartTime}:${summary.deploymentUids.join(',')}`;
}
