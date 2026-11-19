// Receives counted by sender, as the radio statistics carry them: decoding them, banking them across a restart, and
// telling a tag that hears poorly from one the others cannot hear. The scenarios are the two live tests that
// motivated it: two tags with damaged antennas among five, whose failures showed up in the good tags' counts too, and
// three good tags with one of them near something transmitting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLE_RADIO_STATS_VERSION, LIVE_BIN_MS, LiveRadioRecorder, MAX_NUM_RANGING_DEVICES, NUM_XMIT_ANTENNAS, RADIO_STATS_LAYOUT,
  analyseRadio, decodeRadioStats, separateReceptions,
  type RadioStats, type RadioSummary, type Reception, type SenderCounts,
} from '../src/index.ts';

/** A radio statistics read with these senders, every other counter zero. */
function encodeStats(senders: readonly SenderCounts[], version = BLE_RADIO_STATS_VERSION): Uint8Array {
  const out = new Uint8Array(RADIO_STATS_LAYOUT.size);
  const view = new DataView(out.buffer);
  const at = (name: string) => RADIO_STATS_LAYOUT.fields.find((f) => f.name === name)!.offset;
  view.setUint8(at('version'), version);
  view.setUint8(at('sender_count'), senders.length);
  senders.forEach((sender, row) => {
    view.setUint8(at('sender_uids') + row, sender.uid);
    for (let antenna = 0; antenna < NUM_XMIT_ANTENNAS; antenna += 1) {
      view.setUint32(at('sender_rx_ok') + (row * NUM_XMIT_ANTENNAS + antenna) * 4, sender.rxOkByAntenna[antenna]!, true);
      view.setUint32(at('sender_rx_failed') + (row * NUM_XMIT_ANTENNAS + antenna) * 4, sender.rxFailedByAntenna[antenna]!, true);
    }
  });
  return out;
}

test('a radio statistics read carries the receives by sender, and an unknown layout is refused', () => {
  const senders = [
    { uid: 0x3e, rxOkByAntenna: [1000, 2000, 3000], rxFailedByAntenna: [1, 2, 3] },
    { uid: 0x48, rxOkByAntenna: [0, 1990, 400], rxFailedByAntenna: [2000, 10, 1600] },
  ];
  assert.equal(RADIO_STATS_LAYOUT.size, 309);
  assert.equal(MAX_NUM_RANGING_DEVICES, 10);
  assert.deepEqual(decodeRadioStats(encodeStats(senders)).senders, senders);
  assert.deepEqual(decodeRadioStats(encodeStats([])).senders, []);
  assert.throws(() => decodeRadioStats(encodeStats(senders, BLE_RADIO_STATS_VERSION - 1)), /layout 2/);
  assert.throws(() => decodeRadioStats(new Uint8Array(58)), /309 bytes/);
});

/** Every tag's receives from every other, from per-antenna qualities: p(r decodes t through a) = q[r][a] × q[t][a]. */
function receptionsFrom(
  quality: ReadonlyMap<number, readonly number[]>, perCell = 2400, extraMiss = new Map<number, readonly number[]>(),
  pairMiss = new Map<string, number | readonly number[]>(), sending: ReadonlyMap<number, readonly number[]> = quality,
): Reception[] {
  const out: Reception[] = [];
  for (const [receiver, rq] of quality) {
    for (const [sender, sq] of sending) {
      if (receiver === sender) continue;
      const miss = pairMiss.get(`${receiver}<${sender}`) ?? 0;
      const pair = (a: number) => 1 - (typeof miss === 'number' ? miss : miss[a]!);
      const success = rq.map((q, a) => q * sq[a]! * (1 - (extraMiss.get(receiver)?.[a] ?? 0)) * pair(a));
      const rxOk = success.map((p) => Math.round(perCell * p));
      out.push({ receiver, sender, rxOk, rxFailed: rxOk.map((ok) => perCell - ok) });
    }
  }
  return out;
}

const GOOD = [1, 1, 1];
const FIVE = new Map<number, readonly number[]>([
  [0x14, GOOD], [0x3e, GOOD], [0xf4, GOOD],
  [0x48, [0.05, 0.99, 0.3]],   // antennas 1 and 3 all but gone
  [0x49, [0.4, 0.8, 0.35]],
]);

test('two bad tags among five no longer make the good ones look bad: each is judged by its own factor', () => {
  const { qualities, references } = separateReceptions([...FIVE.keys()], receptionsFrom(FIVE));
  assert.deepEqual(references, [0x14, 0x3e, 0xf4]);
  for (const uid of [0x14, 0x3e, 0xf4]) {
    const q = qualities.get(uid)!;
    assert.ok(q.hears! > 0.99 && q.heard! > 0.99, `0x${uid.toString(16)} hears ${q.hears} and is heard ${q.heard}`);
  }
  // The damaged antennas show on both sides, since an antenna that cannot receive cannot transmit either
  assert.ok(qualities.get(0x48)!.hearsByAntenna[0]! < 0.1 && qualities.get(0x48)!.heardByAntenna[0]! < 0.1);
  assert.ok(qualities.get(0x48)!.hearsByAntenna[1]! > 0.95);
  assert.ok(qualities.get(0x49)!.hears! < 0.6 && qualities.get(0x49)!.heard! < 0.6);
});

/** A live summary whose diagnostics carry `bySender`, and ranges to every other tag in every round. */
function liveSummary(self: number, all: readonly number[], receptions: readonly Reception[], distanceMm = 1000): RadioSummary {
  const mine = receptions.filter((r) => r.receiver === self);
  const ok = mine.flatMap((r) => r.rxOk);
  const failed = mine.flatMap((r) => r.rxFailed);
  const byAntenna = (counts: (r: Reception) => readonly number[]) =>
    Array.from({ length: NUM_XMIT_ANTENNAS }, (_, a) => mine.reduce((sum, r) => sum + counts(r)[a]!, 0));
  const bins = Array.from({ length: 8 }, (_, bin) => bin);
  return {
    experimentStartTime: 1795058040, deploymentUids: all, deploymentLabels: all.map(() => ''), selfUid: self,
    firstMs: 0, lastMs: 8 * LIVE_BIN_MS, binMs: LIVE_BIN_MS,
    rowsByBin: bins.map((bin) => [bin, 30] as const),
    peers: all.filter((uid) => uid !== self).map((uid) => ({ uid, bins: bins.map((bin) => [bin, 30, distanceMm, 10] as const) })),
    diagnostics: {
      rxOk: ok.reduce((a, b) => a + b, 0), rxFailed: failed.reduce((a, b) => a + b, 0),
      rxOkByAntenna: byAntenna((r) => r.rxOk), rxFailedByAntenna: byAntenna((r) => r.rxFailed),
      wakeFailures: 0, irqStuck: 0, rxArmLate: 0, txLate: 0, samples: 20,
      bySender: mine.map((r) => ({ uid: r.sender, rxOkByAntenna: r.rxOk, rxFailedByAntenna: r.rxFailed })),
    },
    aborts: 0,
  };
}

const analyse = (quality: Map<number, readonly number[]>, extraMiss?: Map<number, readonly number[]>, pairMiss?: Map<string, number | readonly number[]>) => {
  const uids = [...quality.keys()];
  const receptions = receptionsFrom(quality, 2400, extraMiss, pairMiss);
  return analyseRadio({ devices: uids.map((uid) => ({ uid, label: uid.toString(16), summary: liveSummary(uid, uids, receptions) })) });
};

test('with counts by sender, the good tags pass and the bad ones fail for receiving and sending both', () => {
  const result = analyse(FIVE);
  const verdict = (uid: number) => result.devices.find((device) => device.uid === uid)!;
  for (const uid of [0x14, 0x3e, 0xf4]) {
    assert.equal(verdict(uid).verdict, 'pass', `0x${uid.toString(16)}: ${verdict(uid).reasons.join(' ')}`);
    assert.ok(verdict(uid).rxFailureRate! > 0.2, 'its raw receive failures are still inflated, which is the point');
  }
  for (const uid of [0x48, 0x49]) {
    assert.equal(verdict(uid).verdict, 'fail');
    assert.ok(verdict(uid).reasons.some((reason) => /^\d+% of its receives from the healthy tags failed, against/.test(reason)));
    assert.ok(verdict(uid).reasons.some((reason) => /^The healthy tags failed to receive \d+% of what it sent, against/.test(reason)));
  }
  // 48's first and third antennas are both damaged, and both are named
  assert.ok(verdict(0x48).reasons.includes(
    'Antennas 1 and 3 failed 95% and 70% of its receives from the healthy tags, against 1% through antenna 2. Those antennas, their switch, or their connections are suspect.'),
    verdict(0x48).reasons.join(' | '));
  assert.ok(result.receptions?.length, 'the receptions are there for the page to show');
});

test('a tag near something transmitting fails to hear everyone on one antenna, and is still heard by all', () => {
  const three = new Map<number, readonly number[]>([[0x14, GOOD], [0x3e, GOOD], [0xf4, GOOD]]);
  const result = analyse(three, new Map([[0xf4, [0.26, 0, 0]]]));
  const f4 = result.devices.find((device) => device.uid === 0xf4)!;
  assert.ok(f4.reasons.some((reason) => /^Antenna 1 failed \d+% of its receives from the healthy tags/.test(reason)), f4.reasons.join(' '));
  assert.ok(!f4.reasons.some((reason) => /^The healthy tags/.test(reason)), 'the others hear it fine');
  assert.equal(result.devices.find((device) => device.uid === 0x14)!.verdict, 'pass');
});

test('one pairing that fails both ways is not blamed on a healthy tag in it', () => {
  // A live test as it came out: 48 and 49 weak, and F4 and 49 barely hearing each other although close together.
  // The fit alone split that pairing's losses between them and gave F4 a transmit "Check" it did not deserve.
  const pairMiss = new Map([[`${0x49}<${0xf4}`, 0.85], [`${0xf4}<${0x49}`, 0.85], [`${0x48}<${0xf4}`, 0.3]]);
  const result = analyse(FIVE, undefined, pairMiss);
  const f4 = result.devices.find((device) => device.uid === 0xf4)!;
  assert.equal(f4.verdict, 'pass', f4.reasons.join(' | '));
  assert.ok(f4.quality!.heard! > 0.99 && f4.quality!.hears! > 0.99);
  for (const uid of [0x14, 0x3e]) assert.equal(result.devices.find((device) => device.uid === uid)!.verdict, 'pass');
  for (const uid of [0x48, 0x49]) assert.equal(result.devices.find((device) => device.uid === uid)!.verdict, 'fail');
});

test('a tag that hears badly but sends well overall is no reference, so its one-sided damage is not blamed on another', () => {
  // The next live test as it came out. 48 hears almost nothing through its first and third antennas but sends well
  // overall, except that its first antenna reached 3E far worse than anyone else. Counted as a tag that sends well, 48
  // was one of the references 3E was measured against, and 3E failed for 48's fault. Only tags with nothing wrong with
  // them, receiving or sending, are references now.
  const hearing = new Map<number, readonly number[]>([
    [0x14, GOOD], [0x3e, GOOD], [0xf4, GOOD], [0x48, [0, 1, 0.29]], [0x49, [0.38, 1, 0.66]],
  ]);
  const sending = new Map<number, readonly number[]>([
    [0x14, GOOD], [0x3e, GOOD], [0xf4, GOOD], [0x48, GOOD], [0x49, [0.76, 0.96, 0.69]],
  ]);
  const pairMiss = new Map<string, number | readonly number[]>([
    [`${0x3e}<${0x48}`, [0.7, 0, 0]], [`${0x49}<${0xf4}`, 0.85], [`${0xf4}<${0x49}`, 0.85],
  ]);
  const uids = [...hearing.keys()];
  const receptions = receptionsFrom(hearing, 2400, undefined, pairMiss, sending);
  const result = analyseRadio({ devices: uids.map((uid) => ({ uid, label: uid.toString(16), summary: liveSummary(uid, uids, receptions) })) });
  for (const uid of [0x14, 0x3e, 0xf4]) {
    const device = result.devices.find((d) => d.uid === uid)!;
    assert.equal(device.verdict, 'pass', `0x${uid.toString(16)}: ${device.reasons.join(' | ')}`);
  }
  for (const uid of [0x48, 0x49]) assert.equal(result.devices.find((d) => d.uid === uid)!.verdict, 'fail');
});

// Four tags flagged that morning, tested on their own 2 feet apart: none decodes another well both ways, receiving
// and transmitting well on different antennas
const FLAGGED_HEARING = new Map<number, readonly number[]>([
  [0x4e, [0.48, 0.89, 0.5]], [0x63, [0.7, 0.51, 0.99]], [0x9c, [1, 0.75, 0.43]], [0xc6, [0.69, 0.77, 0.67]],
]);
const FLAGGED_SENDING = new Map<number, readonly number[]>([
  [0x4e, [0.72, 0.54, 0.97]], [0x63, [0.49, 0.89, 0.49]], [0x9c, [0.01, 0.2, 0]], [0xc6, [0.8, 0.85, 0.79]],
]);

const analyseWith = (hearing: ReadonlyMap<number, readonly number[]>, sending: ReadonlyMap<number, readonly number[]>, distanceMm = 1000) => {
  const uids = [...hearing.keys()];
  const receptions = receptionsFrom(hearing, 2400, undefined, undefined, sending);
  return analyseRadio({ devices: uids.map((uid) => ({ uid, label: uid.toString(16), summary: liveSummary(uid, uids, receptions, distanceMm) })) });
};

test('with no pair decoding each other 95% both ways, no tag is the yardstick and each is judged on its own counts', () => {
  const result = analyseWith(FLAGGED_HEARING, FLAGGED_SENDING);
  assert.deepEqual(result.references, []);
  assert.ok(result.notes.some((note) => /^No two tags decoded at least 95% of each other's ranging both ways/.test(note)), result.notes.join(' | '));
  for (const device of result.devices) {
    assert.equal(device.verdict, 'fail', `0x${device.uid.toString(16)}: ${device.reasons.join(' | ')}`);
    assert.ok(!device.reasons.some((reason) => /healthy tags/.test(reason)), 'no tag here is healthy');
  }
  // The least bad tag was the yardstick before, measured against itself and passed
  const c6 = result.devices.find((device) => device.uid === 0xc6)!;
  assert.ok(c6.reasons.some((reason) => /^\d+% of its receives failed\./.test(reason)), c6.reasons.join(' | '));
});

test('a pair decoding each other 95% both ways is the yardstick, however many bad tags are around it', () => {
  const result = analyseWith(new Map([...FLAGGED_HEARING, [0x14, GOOD], [0x3e, GOOD]]), new Map([...FLAGGED_SENDING, [0x14, GOOD], [0x3e, GOOD]]));
  assert.deepEqual(result.references, [0x14, 0x3e]);
  assert.ok(!result.notes.some((note) => /^No two tags/.test(note)));
  for (const uid of [0x14, 0x3e]) {
    const device = result.devices.find((d) => d.uid === uid)!;
    assert.equal(device.verdict, 'pass', `0x${uid.toString(16)}: ${device.reasons.join(' | ')}`);
  }
  for (const uid of FLAGGED_HEARING.keys()) {
    const device = result.devices.find((d) => d.uid === uid)!;
    assert.equal(device.verdict, 'fail');
    assert.ok(device.reasons.some((reason) => /from the healthy tags failed, against/.test(reason)), device.reasons.join(' | '));
  }
});

test('a pair decoding each other 95% overall but not on every antenna is no yardstick', () => {
  const weak = [1, 1, 0.96];   // 92% through antenna 3, 97% over all three
  const hearing = new Map<number, readonly number[]>([[0x14, weak], [0x3e, weak], [0x48, [0.05, 0.99, 0.3]]]);
  const result = analyseWith(hearing, hearing);
  assert.deepEqual(result.references, []);
});

test('tags measured closer than 2 feet are called out, since tags that close reach each other even when damaged', () => {
  const three = new Map<number, readonly number[]>([[0x14, GOOD], [0x3e, GOOD], [0xf4, GOOD]]);
  const close = analyseWith(three, three, 150);
  assert.ok(close.notes.includes('3 pairs of tags measured closer than 2 feet, the closest 14 and 3e at about 15 cm. Place every tag at least ' +
    '2 feet (60 cm) from every other: tags this close reach each other even with damaged antennas, so the check can pass a tag it should fail.'),
    close.notes.join(' | '));
  assert.ok(!analyseWith(three, three, 700).notes.some((note) => /2 feet/.test(note)));
});

test('without counts by sender, the check is exactly as before', () => {
  const uids = [...FIVE.keys()];
  const receptions = receptionsFrom(FIVE);
  const plain = (uid: number) => {
    const { bySender: _, ...diagnostics } = liveSummary(uid, uids, receptions).diagnostics!;
    return { ...liveSummary(uid, uids, receptions), diagnostics };
  };
  const result = analyseRadio({ devices: uids.map((uid) => ({ uid, label: '', summary: plain(uid) })) });
  assert.equal(result.receptions, undefined);
  assert.ok(result.devices.every((device) => device.quality === undefined));
});

test('a live recording banks receives by sender across a restart along with everything else', () => {
  const stats = (rxOk: number, senders: readonly SenderCounts[]): RadioStats => ({
    role: 'ROLE_PARTICIPANT', scheduleSize: 2, testRunning: true, testWaiting: false, testSecondsLeft: 0,
    roundsScheduled: rxOk, roundsRanged: rxOk, rxOk, rxFailed: 0, rxOkByAntenna: [rxOk, 0, 0], rxFailedByAntenna: [0, 0, 0],
    txLate: 0, rxArmLate: 0, isrOverBudget: 0, wakeMaxUs: 0, wakeFailures: 0, antenna: 0, antennaChanges: 0, senders,
  });
  const recorder = new LiveRadioRecorder({ startTime: 1795058040, deploymentUids: [0x14, 0x3e], deploymentLabels: ['', ''], selfUid: 0x14 });
  recorder.addStats(1795058040_000 + 5000, stats(60, [{ uid: 0x3e, rxOkByAntenna: [10, 20, 30], rxFailedByAntenna: [1, 2, 3] }]));
  recorder.addStats(1795058040_000 + 10000, stats(2, [{ uid: 0x3e, rxOkByAntenna: [2, 0, 0], rxFailedByAntenna: [0, 0, 0] }]));   // restarted
  assert.deepEqual(recorder.summary().diagnostics!.bySender, [{ uid: 0x3e, rxOkByAntenna: [12, 20, 30], rxFailedByAntenna: [1, 2, 3] }]);
});

test('a tag that heard nobody leaves the check on its raw counts, as before', () => {
  const uids = [...FIVE.keys()];
  const receptions = receptionsFrom(FIVE);
  const empty = (uid: number) => {
    const summary = liveSummary(uid, uids, receptions);
    return { ...summary, diagnostics: { ...summary.diagnostics!, bySender: [] } };
  };
  const result = analyseRadio({ devices: uids.map((uid) => ({ uid, label: '', summary: empty(uid) })) });
  assert.equal(result.receptions, undefined);
  assert.ok(result.devices.every((device) => device.quality === undefined));
  assert.ok(result.devices.some((device) => device.reasons.some((reason) => /of its ranging receives failed/.test(reason))));
});
