import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../lib/store.mjs';
import { SourceHub, collectRelease } from '../lib/source-client.mjs';
import { makeService } from '../lib/service.mjs';
import { analyze, certificateValidOn, scopeFingerprint, resolveInspection, seedSignatureBaselines } from '../lib/engine.mjs';
import { getVenue } from '../lib/venues.mjs';

const manifest = JSON.parse(readFileSync(new URL('../wire.json', import.meta.url), 'utf8'));
const M1 = getVenue('M1');
const M2 = getVenue('M2');

async function releasesFor(venue) {
  const hub = new SourceHub({ manifest });
  const rows = {};
  for (const phase of venue.phases) rows[phase] = await collectRelease(hub, venue, phase);
  return rows;
}

test('检测有效期左闭右开，且只在证书覆盖工况时可用', () => {
  const certificate = { from_day: '2026-11-01', to_day: '2026-12-08', modes: ['performance'] };
  assert.equal(certificateValidOn(certificate, '2026-11-01'), true);
  assert.equal(certificateValidOn(certificate, '2026-12-08'), false, 'to_day 当天不算有效');

  const release = {
    inspections: [
      { certificate: 'C-A', beam: 'B9', from_day: '2026-01-01', to_day: '2027-01-01', modes: ['rehearsal'] },
    ],
    inheritance: [],
  };
  const result = resolveInspection(release, { point: 'P9', beam: 'B9' }, 'performance', '2026-12-08');
  assert.equal(result.link, null);
  assert.deepEqual(result.ids, []);
  assert.match(result.missing.reasons[0], /演出/);
  assert.deepEqual(result.missing.wrongModeCertificates.map((row) => row.certificate), ['C-A']);
});

test('换梁后只有场馆明示沿用且覆盖本工况才能关联旧检测', async () => {
  const releases = await releasesFor(M1);
  const interim = releases.interim;
  const confirmed = releases.confirmed;

  const inherited = resolveInspection(interim, { point: 'P1', beam: 'B3' }, 'rehearsal', '2026-12-08');
  assert.equal(inherited.link, 'inheritance');
  assert.deepEqual(inherited.ids, ['I1']);

  const performance = resolveInspection(interim, { point: 'P1', beam: 'B3' }, 'performance', '2026-12-08');
  assert.equal(performance.link, null, '沿用声明只写了彩排，演出不能引用');
  assert.equal(performance.missing.inheritanceRejected[0].certificate, 'I1');

  const direct = resolveInspection(confirmed, { point: 'P1', beam: 'B3' }, 'performance', '2026-12-08');
  assert.equal(direct.link, 'direct');
  assert.deepEqual(direct.ids, ['I3']);
});

test('中途缺一页检测时，该区列所缺材料，他不受影响的分区仍可交签', async () => {
  const releases = await releasesFor(M1);
  const store = new Store(null);
  seedSignatureBaselines({ store, venue: M1, releases: Object.values(releases) });

  const result = analyze({ venue: M1, release: releases.interim, proposal: 'P7', callId: 'C2', store });
  assert.equal(result.inspectionIssues.length, 1);
  assert.equal(result.inspectionIssues[0].resource, 'inspection-c');

  const zl = result.zones.find((zone) => zone.zone === 'ZL');
  const zr = result.zones.find((zone) => zone.zone === 'ZR');
  assert.equal(zl.status, 'missing');
  assert.equal(zl.missing[0].beam, 'B3');
  assert.equal(zr.status, 'signed', '另一分区资料齐全仍保持签字');
  assert.equal(zr.handover.status, 'ready', 'ZR 无留存物件且签字仍适用，可交接');
});

test('清场条件区：送签允许，现场交接挂起', async () => {
  const releases = await releasesFor(M1);
  const result = analyze({ venue: M1, release: releases.opening, proposal: 'P7', callId: 'C2' });
  const zl = result.zones.find((zone) => zone.zone === 'ZL');
  assert.equal(zl.conditionalClearing, true);
  const heldCodes = zl.conflicts.map((row) => row.code);
  assert.ok(heldCodes.includes('actual-over-limit'), '留存重量应计入实际合计');
  const actualOver = zl.conflicts.find((row) => row.code === 'actual-over-limit');
  assert.equal(actualOver.blocking, false, '清场条件区不因留存重量阻止送签');
  assert.equal(zl.submitAllowed, true);
  assert.equal(zl.handover.status, 'held');
  assert.match(zl.handover.reasons[0], /清空/);
});

test('非清场条件区：未确认撤场的留存物件必须纳入新工况，否则阻断送签', async () => {
  const releases = await releasesFor(M2);
  const result = analyze({ venue: M2, release: releases.confirmed, proposal: 'T3', callId: 'D2' });
  const zb = result.zones.find((zone) => zone.zone === 'ZB');
  assert.equal(zb.submitAllowed, false);
  assert.ok(zb.conflicts.some((row) => row.code === 'retained-not-declared' && row.blocking));
  assert.equal(zb.status, 'conflict');
  const reminder = result.reminders.find((row) => row.zone === 'ZB' && row.kind === 'mounted-uncleared');
  assert.ok(reminder, '未确认撤场必须出现在提醒中');
  assert.equal(reminder.venueConditional, false);
});

test('局部换梁或增重后旧签字失效，且同区物件须一并重签', async () => {
  const releases = await releasesFor(M1);
  const store = new Store(null);
  seedSignatureBaselines({ store, venue: M1, releases: Object.values(releases) });

  const confirmed = analyze({ venue: M1, release: releases.confirmed, proposal: 'P8', callId: 'C2', store });
  const zl = confirmed.zones.find((zone) => zone.zone === 'ZL');
  assert.equal(zl.signature.status, 'resign');
  assert.equal(zl.signature.receipt, 'SIGN-1');
  assert.ok(zl.signature.changes.some((line) => /B1 变为 B3/.test(line)), zl.signature.changes.join(';'));
  assert.ok(zl.signature.changes.some((line) => /450 kg 变为 495 kg/.test(line)));
  const reminder = confirmed.reminders.find((row) => row.zone === 'ZL' && row.kind === 'signed-scope-changed');
  assert.ok(reminder);
  assert.match(reminder.requires, /一并重新确认/);

  const zr = confirmed.zones.find((zone) => zone.zone === 'ZR');
  assert.equal(zr.signature.status, 'resign', '换清单版次须补签，不能沿用旧回执');
  assert.match(zr.signature.reasons[0], /版次/);
});

test('同区其它清单的物件共用限额，不能以旧签字覆盖新清单', async () => {
  const releases = await releasesFor(M1);
  const store = new Store(null);
  seedSignatureBaselines({ store, venue: M1, releases: Object.values(releases) });
  const result = analyze({ venue: M1, release: releases.confirmed, proposal: 'P9', callId: 'C2', store });
  const zl = result.zones.find((zone) => zone.zone === 'ZL');
  assert.equal(zl.status, 'resign');
  assert.ok(result.reminders.some((row) => row.zone === 'ZL' && row.kind === 'shared-zone-different-scope'));
});

test('彩排到演出切换后，上一工况的签字不能沿用', async () => {
  const release = {
    ...await releasesFor(M2).then((rows) => rows.confirmed),
  };
  const store = new Store(null);
  // Sign ZA for rehearsal through the venue portal observation, then evaluate performance.
  const rehearsal = analyze({ venue: M2, release, proposal: 'T2', callId: 'D1', store });
  const za = rehearsal.zones[0];
  assert.equal(za.mode, 'rehearsal');
  store.putPortal({
    key: 'k-1',
    venue: 'M2',
    zone: 'ZA',
    proposal: 'T2',
    call: 'D1',
    mode: 'rehearsal',
    fingerprint: za.scopeDigest,
    phase: 'confirmed',
    receipt: 'R-1',
    decision: 'signed',
    createdAt: '2026-12-01T00:00:00.000Z',
  });
  const performance = analyze({ venue: M2, release, proposal: 'T1', callId: 'D2', store });
  const zpa = performance.zones.find((zone) => zone.zone === 'ZA');
  assert.equal(zpa.signature.status !== 'signed', true, '跨工况签字不得沿用');
});

test('装台包送签、门户回执与换清单后的变更复核', async () => {
  const hub = new SourceHub({ manifest });
  const store = new Store(null);
  const service = makeService({ hub, store });

  const pack = await service.buildPack({ venue: 'M1', phase: 'opening', proposal: 'P7', call: 'C2' });
  assert.equal(pack.zones.length, 2);
  assert.equal(pack.zones.every((zone) => zone.submitAllowed), true);

  const submitted = await service.submit({ venue: 'M1', pack: pack.id });
  assert.equal(submitted.accepted, 2);
  for (const row of submitted.results) {
    assert.equal(row.reply.decision, 'received');
    const receipt = await service.inspectPortal({ venue: 'M1', key: row.key });
    assert.equal(receipt.decision, 'signed');
  }
  const after = await service.analysis({ venue: 'M1', phase: 'opening', proposal: 'P7', call: 'C2' });
  assert.ok(after.zones.every((zone) => zone.signature.status === 'signed'));
  assert.ok(after.zones.every((zone) => zone.signature.source === 'portal'));

  const review = await service.reviewPack({ venue: 'M1', pack: pack.id });
  assert.ok(review.comparisons.every((row) => row.state === 'unchanged'));
  assert.equal(review.dropped.length, 0);
});

test('冲突的分区不送签，场馆拒收原因与来源事实一并保留', async () => {
  const hub = new SourceHub({ manifest });
  const store = new Store(null);
  const service = makeService({ hub, store });
  const pack = await service.buildPack({ venue: 'M2', proposal: 'T3', call: 'D2' });
  const result = await service.submit({ venue: 'M2', pack: pack.id });
  assert.equal(result.accepted, 0);
  assert.equal(result.results[0].status, 409);
  assert.match(result.results[0].reasons.join(''), /边幕丁/);
});

test('下一站按当地场馆资料重办，并能查到上一站装台记录', async () => {
  const hub = new SourceHub({ manifest });
  const store = new Store(null);
  const service = makeService({ hub, store });
  const m1pack = await service.buildPack({ venue: 'M1', phase: 'opening', proposal: 'P7', call: 'C2' });
  const m2analysis = await service.analysis({ venue: 'M2', proposal: 'T1', call: 'D2' });
  assert.equal(m2analysis.zones[0].signature.status, 'none', '不能沿用上一站签字');
  const previous = m2analysis.previousPacks.find((row) => row.id === m1pack.id);
  assert.ok(previous, '应能找到上一站装台记录');
  assert.equal(previous.venue, 'M1');
  assert.ok(previous.confirmedZones.includes('ZL'));

  const m2pack = await service.buildPack({ venue: 'M2', proposal: 'T1', call: 'D2' });
  assert.equal(m2pack.proposal, 'T1');
  assert.notEqual(m2pack.zones[0].limitKg, m1pack.zones[0].limitKg, '限额取自当地场馆');
});

test('已搭好分区不会因换清单从提醒中消失', async () => {
  const hub = new SourceHub({ manifest });
  const store = new Store(null);
  const service = makeService({ hub, store });
  await service.buildPack({ venue: 'M1', phase: 'opening', proposal: 'P7', call: 'C2' });
  const pack = (await service.packs('M1'))[0];
  await service.submit({ venue: 'M1', pack: pack.id, zone: 'ZR' });
  // A later release only lists ZL items; the previously submitted ZR must not vanish.
  const result = await service.analysis({ venue: 'M1', phase: 'confirmed', proposal: 'P9', call: 'C2' });
  assert.ok(result.zones.some((zone) => zone.zone === 'ZR'), 'ZR 仍在本版清单中，须保留');
  const review = await service.reviewPack({ venue: 'M1', pack: pack.id });
  assert.ok(review.comparisons.length >= 1);
});

test('装台包指纹随工况、梁、重量与检测变化', () => {
  const base = {
    zone: 'Z', mode: 'performance', limitKg: 800,
    declared: [{ item: '甲', point: 'P1', beam: 'B1', kg: 100, group: 'g' }],
    inspectionIds: ['I1'], retainedLoad: [],
  };
  const baseFingerprint = scopeFingerprint(base);
  assert.equal(scopeFingerprint({ ...base }), baseFingerprint);
  assert.notEqual(scopeFingerprint({ ...base, mode: 'rehearsal' }), baseFingerprint);
  assert.notEqual(scopeFingerprint({ ...base, limitKg: 700 }), baseFingerprint);
  assert.notEqual(scopeFingerprint({ ...base, declared: [{ ...base.declared[0], beam: 'B3' }] }), baseFingerprint);
  assert.notEqual(scopeFingerprint({ ...base, declared: [{ ...base.declared[0], kg: 120 }] }), baseFingerprint);
  assert.notEqual(scopeFingerprint({ ...base, inspectionIds: ['I3'] }), baseFingerprint);
});

test('门户流程：同报文重放、异报文冲突、查询回执', async () => {
  const hub = new SourceHub({ manifest });
  const payload = { action: 'send', key: 'test-key-1', facts: { zone: 'ZL' } };
  const first = await hub.postPortal(M1, 'opening', payload);
  assert.equal(first.decision, 'received');
  const replay = await hub.postPortal(M1, 'opening', payload);
  assert.deepEqual(replay, first);
  await assert.rejects(
    () => hub.postPortal(M1, 'opening', { ...payload, facts: { zone: 'ZR' } }),
    (error) => error.status === 409,
  );
  const inspected = await hub.postPortal(M1, 'confirmed', { action: 'inspect', key: 'test-key-1' });
  assert.equal(inspected.decision, 'signed');
  await assert.rejects(
    () => hub.postPortal(M1, 'opening', { action: 'inspect', key: 'missing-key' }),
    (error) => error.status === 404,
  );
});

test('现场仍挂着且被重新申报的物件重量不一致时不淡化实际载荷', () => {
  const venue = {
    id: 'MX', name: '测试场馆', station: '测试站', source: 'local', dir: 'm2', phases: ['confirmed'], defaultPhase: 'confirmed',
  };
  const release = {
    phase: 'confirmed', revision: 'TX', index: { revision: 'TX', conditionalClearingZones: [] },
    calls: [{ call: 'X1', kind: 'performance', venue: 'MX', opens: '2026-12-18T20:00+08:00' }],
    points: [{ point: 'X1', beam: 'BX', zone: 'ZX', modes: ['performance'] }],
    zones: [{ zone: 'ZX', mode: 'performance', limitKg: 500 }],
    set: [{ proposal: 'XS', call: 'X1', item: '边幕', point: 'X1', kg: 420, group: '同步' }],
    inspections: [{ certificate: 'IX', beam: 'BX', from_day: '2026-12-01', to_day: '2027-03-01', modes: ['performance'] }],
    inheritance: [], signatures: [],
    mounted: [{ id: 'R1', venue: 'MX', point: 'X1', zone: 'ZX', item: '边幕', kg: 520, until: '2026-12-18T19:00+08:00', cleared: 'pending' }],
    inspectionPages: ['inspection-a'], inspectionIssues: [], sourceCalls: [],
  };
  const result = analyze({ venue, release, proposal: 'XS', callId: 'X1' });
  const zone = result.zones[0];
  assert.equal(zone.totalActualKg, 520, '实际合计取两者较大值');
  assert.ok(zone.conflicts.some((row) => row.code === 'retained-weight-mismatch' && row.blocking));
  assert.equal(zone.submitAllowed, false);
});

test('场馆资料重发时同一区若限额变化，旧签字不再完全适用', async () => {
  const releases = await releasesFor(M1);
  const store = new Store(null);
  seedSignatureBaselines({ store, venue: M1, releases: Object.values(releases) });

  const changed = {
    ...releases.opening,
    phase: 'confirmed',
    revision: 'S9',
    zones: releases.opening.zones.map((row) => (row.zone === 'ZR' ? { ...row, limitKg: 400 } : row)),
  };
  const result = analyze({ venue: M1, release: changed, proposal: 'P7', callId: 'C2', store });
  const zr = result.zones.find((zone) => zone.zone === 'ZR');
  assert.equal(zr.signature.status, 'resign');
  assert.ok(zr.signature.changes.some((line) => /限额/.test(line)), zr.signature.changes.join(';'));
});

test('装台包送签失败时保留可重试状态，不误记为已签', async () => {
  const hub = new SourceHub({ manifest });
  const store = new Store(null);
  const service = makeService({ hub, store });
  const pack = await service.buildPack({ venue: 'M2', proposal: 'T1', call: 'D2' });
  const realPost = hub.postPortal.bind(hub);
  hub.postPortal = async () => { throw Object.assign(new Error('门户未及时回传'), { status: 503 }); };
  const failed = await service.submit({ venue: 'M2', pack: pack.id });
  assert.equal(failed.accepted, 0);
  assert.equal(failed.results[0].retryable, true);
  const records = store.portalForVenue('M2');
  assert.equal(records[0].decision, 'submit-failed');
  assert.equal(records[0].portalState, 'unavailable');
  hub.postPortal = realPost;
  const retried = await service.submit({ venue: 'M2', pack: pack.id });
  assert.equal(retried.accepted, 1);
});

test('清单换掉某区后，已签字或已送签的该区仍留在变更提醒中', async () => {
  const releases = await releasesFor(M1);
  const store = new Store(null);
  const service = makeService({ hub: new SourceHub({ manifest }), store });

  const pack = await service.buildPack({ venue: 'M1', phase: 'opening', proposal: 'P7', call: 'C2' });
  const submitted = await service.submit({ venue: 'M1', pack: pack.id, zone: 'ZR' });
  for (const row of submitted.results) {
    if (row.accepted) await service.inspectPortal({ venue: 'M1', key: row.key });
  }

  // A later release whose P7 list only carries ZL items, so ZR disappears.
  const trimmed = {
    ...releases.opening,
    set: releases.opening.set.filter((row) => row.point !== 'P4'),
  };
  const result = analyze({ venue: M1, release: trimmed, proposal: 'P7', callId: 'C2', store });
  assert.deepEqual(result.zones.map((zone) => zone.zone), ['ZL']);
  const kinds = result.reminders.filter((row) => row.zone === 'ZR').map((row) => row.kind);
  assert.ok(kinds.includes('signed-zone-absent'), kinds.join(','));
  assert.ok(kinds.includes('signed-zone-dropped'), '已送签的 ZR 不能悄悄消失');
});

test('装台包中的分区不在当前清单时同样保留提醒', async () => {
  const releases = await releasesFor(M1);
  const store = new Store(null);
  const service = makeService({ hub: new SourceHub({ manifest }), store });
  await service.buildPack({ venue: 'M1', phase: 'opening', proposal: 'P7', call: 'C2' });
  const trimmed = { ...releases.opening, signatures: [], set: releases.opening.set.filter((row) => row.point !== 'P4') };
  const result = analyze({ venue: M1, release: trimmed, proposal: 'P7', callId: 'C2', store });
  const kinds = result.reminders.filter((row) => row.zone === 'ZR').map((row) => row.kind);
  assert.ok(kinds.includes('pack-zone-not-in-plan'), kinds.join(','));
});
