import { digest, sortedUnique, sumKg } from './util.mjs';

export const MODE_LABEL = { rehearsal: '彩排', performance: '演出' };
const itemKey = (item, point) => String(item) + '\u0000' + String(point);

export function modeLabel(mode) {
  return MODE_LABEL[mode] ?? mode;
}

export function callDay(call) {
  return String(call?.opens ?? '').slice(0, 10);
}

/** Venue certificate validity is left-closed, right-open on the call date. */
export function certificateValidOn(certificate, day) {
  return String(certificate.from_day) <= day && day < String(certificate.to_day);
}

function rows(release, key) {
  return Array.isArray(release[key]) ? release[key] : [];
}

export function listPlans(release) {
  const calls = new Map(rows(release, 'calls').map((call) => [call.call, call]));
  const points = new Map(rows(release, 'points').map((point) => [point.point, point]));
  const plans = new Map();
  for (const row of rows(release, 'set')) {
    const key = row.proposal + '\u0000' + row.call;
    if (!plans.has(key)) {
      plans.set(key, {
        key,
        proposal: row.proposal,
        call: row.call,
        mode: calls.get(row.call)?.kind ?? null,
        opens: calls.get(row.call)?.opens ?? null,
        items: 0,
        zones: new Set(),
        kg: 0,
      });
    }
    const plan = plans.get(key);
    plan.items += 1;
    plan.kg += Number.isFinite(row.kg) ? row.kg : 0;
    const zone = points.get(row.point)?.zone;
    if (zone) plan.zones.add(zone);
  }
  return [...plans.values()]
    .map((plan) => ({ ...plan, zones: [...plan.zones].sort() }))
    .sort((a, b) => String(a.proposal).localeCompare(String(b.proposal)) || String(a.call).localeCompare(String(b.call)));
}

/**
 * Resolves a point's beam to the certificates the venue allows for this mode.
 * Accepted bases only:
 *   - a certificate registered directly for that beam, covering the mode, valid that day;
 *   - a venue inheritance row that explicitly names old beam -> new beam and lists
 *     the mode, backed by the named certificate.
 * Nothing is inferred from similar beam numbers and no structural load is recalculated.
 */
export function resolveInspection(release, point, mode, day) {
  const inspections = rows(release, 'inspections');
  const inheritance = rows(release, 'inheritance');
  const dayOk = (cert) => certificateValidOn(cert, day);

  const direct = inspections.filter(
    (cert) => cert.beam === point.beam && (cert.modes ?? []).includes(mode) && dayOk(cert),
  );
  if (direct.length) {
    return {
      link: 'direct',
      ids: sortedUnique(direct.map((cert) => cert.certificate)),
      certificates: direct.map((cert) => ({ ...cert, link: 'direct' })),
      basis: `检测证书直接登记梁 ${point.beam}，覆盖${modeLabel(mode)}且在 ${day} 有效`,
    };
  }

  const declared = inheritance.filter((row) => row.new_beam === point.beam);
  const usable = [];
  const rejected = [];
  for (const row of declared) {
    const certificate = inspections.find((cert) => cert.certificate === row.certificate);
    const reasons = [];
    if (!certificate) {
      reasons.push('沿用声明引用的证书未在本版发布');
    } else {
      if (certificate.beam !== row.old_beam) reasons.push('沿用声明的新旧梁对应与证书登记不一致');
      if (!(certificate.modes ?? []).includes(mode)) reasons.push(`证书未覆盖${modeLabel(mode)}`);
      if (!dayOk(certificate)) reasons.push(`证书在 ${day} 不处于有效期`);
    }
    if (!(row.modes ?? []).includes(mode)) reasons.push(`场馆沿用声明未覆盖${modeLabel(mode)}`);
    if (reasons.length) rejected.push({ certificate: row.certificate, old_beam: row.old_beam, reasons });
    else usable.push({ row, certificate });
  }
  if (usable.length) {
    return {
      link: 'inheritance',
      ids: sortedUnique(usable.map(({ certificate }) => certificate.certificate)),
      certificates: usable.map(({ certificate, row }) => ({
        ...certificate,
        link: 'inheritance',
        inheritedFrom: row.old_beam,
        inheritanceModes: row.modes,
        basis: `场馆明示 ${row.old_beam} → ${row.new_beam} 沿用 ${row.certificate}（仅限 ${(row.modes ?? []).map(modeLabel).join('、')}）`,
      })),
      originalBeams: usable.map(({ row }) => row.old_beam),
      basis: usable
        .map(({ row }) => `场馆明示 ${row.old_beam} → ${row.new_beam} 沿用 ${row.certificate}（仅限 ${(row.modes ?? []).map(modeLabel).join('、')}）`)
        .join('；'),
    };
  }

  const wrongMode = inspections.filter(
    (cert) => cert.beam === point.beam && !(cert.modes ?? []).includes(mode) && dayOk(cert),
  );
  return {
    link: null,
    ids: [],
    certificates: [],
    basis: null,
    missing: {
      beam: point.beam,
      mode,
      day,
      reasons: [
        `梁 ${point.beam} 没有适用于${modeLabel(mode)}且 ${day} 当天有效的检测证书`,
        declared.length ? '场馆现有沿用声明不适用于本工况' : '场馆未出具该梁的旧检测沿用声明',
      ],
      wrongModeCertificates: wrongMode.map((cert) => ({ certificate: cert.certificate, modes: cert.modes })),
      inheritanceRejected: rejected,
    },
  };
}

/**
 * Digest of what a zone actually carries: mode, objects, points, beams, loads,
 * groups, linked certificates and undeclared retained load. The plan revision
 * is intentionally not part of it — an unchanged zone scope can carry an older
 * receipt, provided it is demonstrably unchanged.
 */
export function scopeFingerprint({ zone, mode, limitKg = null, declared, inspectionIds, retainedLoad }) {
  return digest({
    zone,
    mode,
    limitKg,
    declared: declared
      .map((item) => ({ item: item.item, point: item.point, beam: item.beam, kg: item.kg, group: item.group }))
      .sort((a, b) => (a.item + a.point).localeCompare(b.item + b.point)),
    inspections: [...inspectionIds].sort(),
    retained_load: [...retainedLoad].sort((a, b) => (a.item + a.point).localeCompare(b.item + b.point)),
  });
}

export function diffFacts(baseline, current) {
  if (!baseline) return [];
  const changes = [];
  if (baseline.mode !== current.mode) changes.push(`工况由${modeLabel(baseline.mode)}变为${modeLabel(current.mode)}`);
  if (baseline.limitKg !== current.limitKg) {
    changes.push(`同区并用限额由 ${baseline.limitKg ?? '未发布'} kg 变为 ${current.limitKg ?? '未发布'} kg`);
  }
  const before = new Map((baseline.declared ?? []).map((item) => [itemKey(item.item, item.point), item]));
  const after = new Map((current.declared ?? []).map((item) => [itemKey(item.item, item.point), item]));
  for (const [key, item] of after) {
    const old = before.get(key);
    if (!old) {
      changes.push(`新增物件 ${item.item}（${item.point}，${item.kg} kg）`);
      continue;
    }
    if (old.kg !== item.kg) changes.push(`${item.item} 申报重量由 ${old.kg} kg 变为 ${item.kg} kg`);
    if (old.beam !== item.beam) changes.push(`${item.item} 所在吊点 ${item.point} 的梁由 ${old.beam} 变为 ${item.beam}（局部换梁）`);
    if (old.group !== item.group) changes.push(`${item.item} 编组由 ${old.group} 变为 ${item.group}`);
  }
  for (const [key, item] of before) {
    if (!after.has(key)) changes.push(`移除物件 ${item.item}（${item.point}）`);
  }
  const oldIds = new Set(baseline.inspectionIds ?? []);
  const newIds = new Set(current.inspectionIds ?? []);
  for (const id of newIds) if (!oldIds.has(id)) changes.push(`适用检测增加 ${id}`);
  for (const id of oldIds) if (!newIds.has(id)) changes.push(`适用检测不再包括 ${id}`);
  const shape = (list) => JSON.stringify(list.map((row) => [row.item, row.point, row.kg]));
  if (shape(baseline.retainedLoad ?? []) !== shape(current.retainedLoad ?? [])) {
    changes.push('同区现场留存物件的申报重量发生变化');
  }
  return changes;
}

/**
 * What a signature's own declared fields correspond to in one release. Used
 * only to seed the baseline for a receipt: the signature names its plan
 * revision, zone, mode and inspection ids, and those must line up with that
 * release's set/points/certificates. A changed release never becomes the
 * baseline it is compared against later.
 */
export function signatureBaseline(release, signature) {
  if (signature.plan_rev !== signature.proposal) return null;
  const calls = rows(release, 'calls').filter(
    (row) => row.kind === signature.mode && (!row.venue || !signature.venue || row.venue === signature.venue),
  );
  if (!calls.length) return null;
  const points = new Map(rows(release, 'points').map((point) => [point.point, point]));
  const signatureIds = sortedUnique(signature.inspection_ids ?? []).join(',');

  for (const call of calls) {
    const day = callDay(call);
    const zoneItems = rows(release, 'set')
      .filter((row) => row.proposal === signature.proposal && row.call === call.call)
      .map((row) => ({ row, point: points.get(row.point) }))
      .filter(({ point }) => point?.zone === signature.zone);
    if (!zoneItems.length) continue;

    const declared = zoneItems.map(({ row, point }) => ({
      item: row.item,
      point: row.point,
      beam: point.beam,
      kg: row.kg,
      group: row.group ?? null,
    }));
    const inspectionIds = sortedUnique(
      zoneItems.flatMap(({ point }) => resolveInspection(release, point, signature.mode, day).ids),
    );
    if (inspectionIds.join(',') !== signatureIds) continue;

    const limitKg = rows(release, 'zones')
      .find((row) => row.zone === signature.zone && row.mode === signature.mode)?.limitKg ?? null;
    // A signature covers what its pack declared. Retained scenery that was not
    // declared is deliberately not folded into the baseline: its later
    // appearance must make the receipt stop fully applying.
    return {
      scopeDigest: scopeFingerprint({
        zone: signature.zone,
        mode: signature.mode,
        limitKg,
        declared,
        inspectionIds,
        retainedLoad: [],
      }),
      facts: {
        zone: signature.zone,
        mode: signature.mode,
        plan_rev: signature.proposal,
        revision: release.revision ?? null,
        limitKg,
        declared,
        inspectionIds,
        retainedLoad: [],
      },
      revision: release.revision ?? null,
    };
  }
  return null;
}

/** Records every signature seen across releases, seeding its baseline in the first matching release. */
export function seedSignatureBaselines({ store, venue, releases }) {
  if (!store) return;
  for (const release of [...releases].filter(Boolean)) {
    for (const signature of rows(release, 'signatures')) {
      const existing = store.signatureRecord(venue.id, signature.receipt);
      const baseline = existing?.scopeDigest ? null : signatureBaseline(release, signature);
      store.observeSignature({ venue: venue.id, phase: release.phase, signature, baseline });
    }
  }
}

function evaluateSignatures({ zone, mode, proposal, scopeDigest, facts, signatureRows, store, venueId, complete }) {
  const sameZone = signatureRows.filter((sig) => sig.zone === zone);
  const candidates = sameZone.filter((sig) => sig.mode === mode && sig.decision === 'signed');
  const result = {
    status: 'none',
    receipt: null,
    source: null,
    reasons: [],
    advisory: [],
    changes: [],
    scope: [],
  };

  if (!complete) {
    if (sameZone.length || candidates.length) {
      result.status = sameZone.length ? 'resign' : 'none';
      result.receipt = sameZone.map((sig) => sig.receipt).join('、') || null;
      result.reasons.push('本区仍有物件取不到可关联的检测，不能认定签字范围完整');
      result.scope = sortedUnique(sameZone.flatMap((sig) => sig.inspection_ids ?? []));
    }
    return result;
  }

  if (!candidates.length) {
    if (sameZone.length) {
      result.status = 'resign';
      result.receipt = sameZone.map((sig) => sig.receipt).join('、');
      const modes = sortedUnique(sameZone.map((sig) => modeLabel(sig.mode)));
      result.reasons.push(
        `${result.receipt} 覆盖的是${modes.join('、')}工况，本次为${modeLabel(mode)}；分区限额与检测适用工况不同，须按本工况重新确认`,
      );
      result.scope = sortedUnique(sameZone.flatMap((sig) => sig.inspection_ids ?? []));
    }
    return result;
  }

  const evaluated = candidates.map((sig) => {
    const reasons = [];
    const observed = store?.signatureRecord(venueId, sig.receipt) ?? null;
    const declaredIds = sortedUnique(sig.inspection_ids ?? []);
    if (declaredIds.join(',') !== [...facts.inspectionIds].sort().join(',')) {
      reasons.push(
        `签字检测为 [${declaredIds.join('、') || '无'}]，当前适用检测为 [${[...facts.inspectionIds].sort().join('、') || '无'}]`,
      );
    }

    if (sig.plan_rev !== proposal || sig.proposal !== proposal) {
      reasons.push(
        `场馆签字按资料版次 ${sig.plan_rev} / 清单 ${sig.proposal} 出具，本装台包为 ${proposal}；场馆确认只覆盖其出具时适用的版次，须按新版次补签`,
      );
    }

    if (observed?.scopeDigest) {
      if (observed.scopeDigest !== scopeDigest) {
        reasons.push('签字之后该区实际申报条件已变化，旧签字范围不再完全适用');
        result.changes.push(...diffFacts(observed.baselineFacts, facts));
      } else if (sig.plan_rev !== proposal || sig.proposal !== proposal) {
        result.advisory.push(
          `本区物件、吊点、梁、载荷、编组与检测和旧签字逐项一致，仅版次不同；可据此快速补签，但不能直接沿用旧回执`,
        );
      } else if (observed.baselineRevision && observed.baselineRevision !== facts.revision) {
        result.advisory.push(
          `场馆资料版次由 ${observed.baselineRevision} 更新为 ${facts.revision}；本区申报内容未变，沿用签字须舞监复核场馆是否重新发布该区`,
        );
      }
    } else if (sig.plan_rev === proposal && sig.proposal === proposal && !reasons.length) {
      result.advisory.push('来源签字声明的分区、工况、版次与检测已与当前装台包逐项一致');
    }

    return { sig, reasons };
  });

  const valid = evaluated.find((entry) => entry.reasons.length === 0);
  if (valid) {
    result.status = 'signed';
    result.receipt = valid.sig.receipt;
    result.source = 'source';
    return result;
  }
  result.status = 'resign';
  result.receipt = evaluated.map((entry) => entry.sig.receipt).join('、');
  result.reasons.push(...evaluated[0].reasons);
  result.scope = sortedUnique(candidates.flatMap((sig) => sig.inspection_ids ?? []));
  return result;
}

/**
 * Pending clearance alerts for every zone with unconfirmed mounted scenery.
 * `declaredKeys` lets a caller treat retained rows already covered by a pack as
 * declared; without it every pending row is reported.
 */
export function mountedAlerts(release, declaredByZone = new Map()) {
  const conditionalZones = new Set(release.index?.conditionalClearingZones ?? []);
  const alerts = [];
  for (const zone of sortedUnique(rows(release, 'mounted').map((row) => row.zone))) {
    const pending = rows(release, 'mounted').filter((row) => row.zone === zone && row.cleared !== 'confirmed');
    if (!pending.length) continue;
    const declaredKeys = declaredByZone.get(zone) ?? new Set();
    const live = pending.filter((row) => !declaredKeys.has(itemKey(row.item, row.point)));
    const conditional = conditionalZones.has(zone);
    alerts.push({
      zone,
      kind: 'mounted-uncleared',
      severity: conditional ? 'hold' : 'action',
      message: `${zone} 尚未确认撤场：${pending.map((row) => `${row.item} ${row.kg} kg（计划 ${row.until} 撤场，当前 ${row.cleared === 'pending' ? '待确认' : row.cleared}）`).join('；')}`,
      inSelectedPlan: declaredByZone.has(zone),
      requires: conditional
        ? '送签或补件可继续；现场交接须待场馆确认清空后放行'
        : '本区如继续使用，须把现场留存物件纳入新工况；否则须等待场馆确认拆台后再送签',
      items: live.map((row) => ({ id: row.id, item: row.item, point: row.point, kg: row.kg, until: row.until, cleared: row.cleared })),
      venueConditional: conditional,
    });
  }
  return alerts;
}

/**
 * Builds the supervisory view for one venue release, scenery list and call.
 * Venue material is never mutated here. The only external state read is the
 * local observation store: signature baselines, portal submissions and their
 * receipts.
 */
export function analyze({ venue, release, proposal, callId, store = null }) {
  const call = rows(release, 'calls').find((row) => row.call === callId);
  if (!call) return { error: `场次 ${callId} 不在本版场馆资料中` };
  if (call.venue && call.venue !== venue.id) {
    return { error: `场次 ${callId} 属于场馆 ${call.venue}，不能用于 ${venue.id}` };
  }
  const mode = call.kind;
  const day = callDay(call);
  const proposalRows = rows(release, 'set').filter((row) => row.proposal === proposal && row.call === callId);
  if (!proposalRows.length) {
    return { error: `本版资料中没有布景清单 ${proposal} 在 ${callId} 的申报` };
  }

  const points = new Map(rows(release, 'points').map((point) => [point.point, point]));
  const zonesTable = rows(release, 'zones');
  const signatureRows = rows(release, 'signatures');
  const mounted = rows(release, 'mounted');
  const conditionalZones = new Set(release.index?.conditionalClearingZones ?? []);

  const items = proposalRows.map((row, index) => {
    const point = points.get(row.point) ?? null;
    const issues = [];
    if (!point) {
      issues.push({ code: 'point-missing', message: `吊点 ${row.point} 不在场馆吊点表中` });
    } else if (!(point.modes ?? []).includes(mode)) {
      issues.push({ code: 'point-mode', message: `吊点 ${row.point} 未列入${modeLabel(mode)}工况的可用吊点` });
    }
    if (!Number.isInteger(row.kg) || row.kg < 0) {
      issues.push({ code: 'kg-invalid', message: `申报重量 ${row.kg} 不是场馆要求的整数千克` });
    }
    if (typeof row.group !== 'string' || !row.group.trim()) {
      issues.push({ code: 'group-missing', message: '来源未注明适用编组，不能自行归并或补算' });
    }
    let inspection = { link: null, ids: [], basis: null, certificates: [], missing: null, unusable: [] };
    if (point && (point.modes ?? []).includes(mode)) {
      const resolved = resolveInspection(release, point, mode, day);
      inspection = {
        link: resolved.link,
        ids: resolved.ids,
        basis: resolved.basis,
        certificates: resolved.certificates ?? [],
        originalBeams: resolved.originalBeams ?? [],
        missing: resolved.missing ?? null,
        unusable: resolved.missing?.inheritanceRejected ?? [],
      };
    }
    return {
      index,
      proposal: row.proposal,
      call: row.call,
      item: row.item,
      point: row.point,
      beam: point?.beam ?? null,
      zone: point?.zone ?? null,
      kg: row.kg,
      group: row.group ?? null,
      issues,
      inspection,
    };
  });

  const zoneResults = [];
  for (const zone of sortedUnique(items.map((item) => item.zone).filter(Boolean))) {
    const zoneItems = items.filter((item) => item.zone === zone);
    const limitRow = zonesTable.find((row) => row.zone === zone && row.mode === mode);
    const limitKg = limitRow ? limitRow.limitKg : null;
    const conflicts = [];
    const missing = [];

    for (const item of zoneItems) {
      for (const issue of item.issues) {
        conflicts.push({ ...issue, item: item.item, point: item.point, blocking: true });
      }
      if (!limitRow) {
        conflicts.push({
          code: 'zone-mode',
          message: `承重区 ${zone} 未发布${modeLabel(mode)}工况的并用限额，不能挂载`,
          item: item.item,
          blocking: true,
        });
      }
      if (item.inspection.missing) {
        missing.push({ item: item.item, point: item.point, beam: item.beam, ...item.inspection.missing });
      }
    }

    const groups = [];
    const groupMap = new Map();
    for (const item of zoneItems) {
      const key = item.group ?? '（未注明编组）';
      if (!groupMap.has(key)) {
        const bucket = { group: key, items: [], kg: 0 };
        groupMap.set(key, bucket);
        groups.push(bucket);
      }
      groupMap.get(key).items.push(item.item);
      if (Number.isFinite(item.kg)) groupMap.get(key).kg += item.kg;
    }
    const totalDeclaredKg = sumKg(zoneItems.map((item) => item.kg).filter(Number.isFinite));

    const retainedAll = mounted
      .filter((row) => row.zone === zone && row.cleared !== 'confirmed')
      .map((row) => ({ id: row.id, item: row.item, point: row.point, kg: row.kg, until: row.until, cleared: row.cleared }));
    const declaredKeys = new Map(zoneItems.map((item) => [itemKey(item.item, item.point), item]));
    const retainedExtra = retainedAll.filter((row) => !declaredKeys.has(itemKey(row.item, row.point)));
    const reDeclared = retainedAll.filter((row) => declaredKeys.has(itemKey(row.item, row.point)));
    const retainedKg = sumKg(retainedExtra.map((row) => row.kg).filter(Number.isFinite));
    const conditional = conditionalZones.has(zone);

    // A still-mounted object that is re-declared is claimed at a new weight.
    // The two source figures must agree; otherwise the actual load is unknown
    // and the heavier of the two is used so the zone limit is never understated.
    let unconfirmedKg = 0;
    for (const row of reDeclared) {
      const declared = declaredKeys.get(itemKey(row.item, row.point));
      if (row.kg !== declared.kg) {
        const excess = Math.max(0, row.kg - declared.kg);
        unconfirmedKg += excess;
        conflicts.push({
          code: 'retained-weight-mismatch',
          blocking: !conditional,
          message: `${zone} 现场仍挂着的 ${row.item} 记录 ${row.kg} kg，本清单申报 ${declared.kg} kg；两者不一致，须核实或等待场馆确认卸下`,
          item: row.item,
          point: row.point,
        });
      }
    }
    const totalActualKg = totalDeclaredKg + retainedKg + unconfirmedKg;

    if (limitKg !== null) {
      for (const group of groups) {
        if (group.kg > limitKg) {
          conflicts.push({
            code: 'group-over-limit',
            blocking: true,
            group: group.group,
            items: group.items,
            message: `编组「${group.group}」同工况合计 ${group.kg} kg，超过 ${zone} 在${modeLabel(mode)}的并用限额 ${limitKg} kg`,
          });
        }
      }
      if (totalDeclaredKg > limitKg) {
        conflicts.push({
          code: 'zone-over-limit',
          blocking: true,
          message: `本清单在 ${zone} 申报 ${totalDeclaredKg} kg，超过并用限额 ${limitKg} kg`,
        });
      }
      if (retainedExtra.length && totalActualKg > limitKg) {
        conflicts.push({
          code: 'actual-over-limit',
          blocking: !conditional,
          message: `${zone} 现场仍有未确认撤场的 ${retainedExtra.map((row) => row.item).join('、')} 共 ${retainedKg} kg；连同本清单实际合计 ${totalActualKg} kg 超过限额 ${limitKg} kg`,
        });
      }
      if (retainedExtra.length && !conditional) {
        conflicts.push({
          code: 'retained-not-declared',
          blocking: true,
          message: `${zone} 尚未确认撤场的 ${retainedExtra.map((row) => row.item).join('、')} 必须纳入本工况申报，或等待场馆确认拆台后再送签`,
        });
      }
    }

    const inspectionIds = sortedUnique(zoneItems.flatMap((item) => item.inspection.ids).filter(Boolean));
    const certificates = [];
    const seenCertificates = new Set();
    for (const item of zoneItems) {
      for (const certificate of item.inspection.certificates ?? []) {
        if (seenCertificates.has(certificate.certificate)) continue;
        seenCertificates.add(certificate.certificate);
        certificates.push({ ...certificate, forPoint: item.point, forItem: item.item });
      }
    }
    const retainedLoad = conditional ? [] : retainedExtra.map((row) => ({ item: row.item, point: row.point, kg: row.kg }));
    const facts = {
      zone,
      mode,
      plan_rev: proposal,
      revision: release.revision ?? null,
      limitKg,
      declared: zoneItems.map((item) => ({
        item: item.item,
        point: item.point,
        beam: item.beam,
        kg: item.kg,
        group: item.group,
      })),
      inspectionIds,
      retainedLoad,
    };
    const scopeDigest = scopeFingerprint({
      zone,
      mode,
      limitKg,
      declared: facts.declared,
      inspectionIds,
      retainedLoad,
    });

    const signature = evaluateSignatures({
      zone,
      mode,
      proposal,
      scopeDigest,
      facts,
      signatureRows,
      store,
      venueId: venue.id,
      complete: missing.length === 0,
    });

    const zoneRecords = store ? store.portalForZone(venue.id, zone) : [];
    const submissions = zoneRecords.filter((record) => record.proposal === proposal && record.call === callId);
    const latestSubmission = submissions[0] ?? null;
    const currentSubmission = submissions.find((record) => record.fingerprint === scopeDigest) ?? null;
    const portalSigned = currentSubmission?.decision === 'signed' ? currentSubmission : null;
    const portalPending = currentSubmission && !portalSigned ? currentSubmission : null;
    const signedElsewhere = submissions.filter(
      (record) => record.decision === 'signed' && record.fingerprint !== scopeDigest,
    );
    const signedOtherMode = zoneRecords.filter(
      (record) => record.decision === 'signed' && record.mode != null && record.mode !== mode,
    );

    if (portalSigned) {
      signature.status = 'signed';
      signature.receipt = portalSigned.receipt ?? portalSigned.key;
      signature.reference = portalSigned.sourceRef ?? portalSigned.key;
      signature.source = 'portal';
      signature.reasons = [];
      signature.changes = [];
      signature.scope = [...inspectionIds];
      signature.advisory = ['场馆门户已按装台包的分区、工况、资料版次和检测出具签字回执'];
    } else if (portalPending && signature.status !== 'signed') {
      signature.advisory.push(
        `已送签 ${portalPending.receipt ?? portalPending.key}（${portalPending.decision ?? '待回执'}），场馆回执尚未签出`,
      );
    }
    if (signedElsewhere.length && !portalSigned) {
      signature.advisory.push(
        `本区曾按另一版装台包签字（${signedElsewhere.map((record) => record.receipt ?? record.key).join('、')}），该签字不再覆盖当前装台包`,
      );
    }

    const blockingConflicts = conflicts.filter((row) => row.blocking !== false);
    const submitAllowed = blockingConflicts.length === 0 && missing.length === 0;

    const handoverReasons = [];
    if (conditional && retainedAll.length) {
      handoverReasons.push(
        `${zone} 属场馆要求清空后启用的分区；现场仍有 ${retainedAll.map((row) => `${row.item}（${row.kg} kg，${row.cleared === 'pending' ? '待场馆确认卸下' : row.cleared}）`).join('、')}`,
      );
    }
    if (signature.status !== 'signed') {
      handoverReasons.push('本区尚无覆盖当前工况、资料版次与实际物件的场馆签字回执');
    }
    if (blockingConflicts.length) handoverReasons.push('本区仍有未解决的申报冲突');
    if (missing.length) handoverReasons.push('本区仍缺可关联的检测证书');
    const handover = {
      status: handoverReasons.length ? 'held' : 'ready',
      reasons: handoverReasons,
      venueConditional: conditional,
      clearanceConfirmed: retainedAll.length === 0,
    };

    const otherScopeSigned = signatureRows.some(
      (sig) => sig.zone === zone && sig.proposal === proposal && sig.mode !== mode && sig.decision === 'signed',
    );
    let status;
    if (blockingConflicts.length) status = 'conflict';
    else if (missing.length) status = 'missing';
    else if (signature.status === 'signed') status = 'signed';
    else if (signedElsewhere.length || signedOtherMode.length) status = 'resign';
    else if (portalPending) status = 'submitted';
    else if (signature.status === 'resign' || otherScopeSigned) status = 'resign';
    else if (conditional && retainedExtra.length) status = 'conditional';
    else status = 'ready';
    const statusLabel = {
      conflict: '冲突待改',
      missing: '资料不全',
      signed: '已签字',
      submitted: '已送签，待回执',
      resign: '待重签',
      conditional: '可送签，交接待清场',
      ready: '资料齐全，可交签',
    }[status];

    const sameZoneOtherScope = signatureRows.filter(
      (sig) => sig.zone === zone && sig.proposal !== proposal && sig.decision === 'signed',
    );
    if (sameZoneOtherScope.length && signature.status !== 'signed') {
      signature.advisory.push(
        `同区另有 ${sameZoneOtherScope.map((sig) => `${sig.receipt}（清单 ${sig.proposal}）`).join('、')} 的签字；实际物件或版次不同，须按本装台包重新确认`,
      );
    }

    const staleSubmissions = submissions.filter((record) => record.fingerprint !== scopeDigest);
    if (signedOtherMode.length && !portalSigned) {
      signature.advisory.push(
        `同区在${sortedUnique(signedOtherMode.map((record) => modeLabel(record.mode))).join('、')}工况签过 ${signedOtherMode.map((record) => record.receipt ?? record.key).join('、')}；切换工况后须按本工况重新确认`,
      );
    }
    zoneResults.push({
      zone,
      mode,
      limitKg,
      declared: zoneItems,
      groups,
      totalDeclaredKg,
      retained: retainedAll,
      retainedExtra,
      reDeclared,
      retainedKg: retainedKg + unconfirmedKg,
      unconfirmedKg,
      totalActualKg,
      conditionalClearing: conditional,
      conflicts,
      missing,
      inspections: inspectionIds,
      certificates,
      signature,
      submissions,
      staleSubmissions,
      latestSubmission,
      latestSubmissionState: latestSubmission
        ? (latestSubmission.decision === 'signed' ? 'signed' : 'pending')
        : 'none',
      status,
      statusLabel,
      submitAllowed,
      submitScope: conditional && retainedExtra.length ? 'after-clearing' : 'current',
      handover,
      scopeDigest,
      facts,
    });
  }

  const declaredByZone = new Map(zoneResults.map((result) => [
    result.zone,
    new Set(result.declared.map((item) => itemKey(item.item, item.point))),
  ]));
  const reminders = mountedAlerts(release, declaredByZone);

  // An item whose point is not published cannot be placed in a weight zone.
  // It must still be visible: dropping it silently would understate the load.
  const unplaced = items.filter((item) => !item.zone);
  if (unplaced.length) {
    reminders.push({
      zone: '未定位物件',
      kind: 'item-without-point',
      severity: 'resign',
      message: `以下物件无法定位承重区：${unplaced.map((item) => `${item.item}（吊点 ${item.point}）`).join('、')}`,
      requires: '须向场馆补取吊点—承重区对应关系；这些物件未计入任何分区限额，不能送签',
      items: unplaced.map((item) => ({ item: item.item, point: item.point, kg: item.kg })),
    });
  }
  for (const result of zoneResults) {
    if (result.signature.status === 'resign' && result.signature.changes.length) {
      reminders.push({
        zone: result.zone,
        kind: 'signed-scope-changed',
        severity: 'resign',
        message: `已签字范围条件变化：${result.signature.changes.join('；')}`,
        requires: `同区同编组物件（${(result.groups[0]?.items ?? []).join('、')}）须一并重新确认，不能只重签变化的那一件`,
      });
    }
    const otherMode = signatureRows.filter(
      (sig) => sig.zone === result.zone && sig.proposal === proposal && sig.mode !== mode && sig.decision === 'signed',
    );
    if (otherMode.length) {
      reminders.push({
        zone: result.zone,
        kind: 'mode-switch',
        severity: 'resign',
        message: `本区曾在${sortedUnique(otherMode.map((sig) => modeLabel(sig.mode))).join('、')}工况签过 ${otherMode.map((sig) => sig.receipt).join('、')}，现切换为${modeLabel(mode)}`,
        requires: '彩排与演出的分区限额及检测适用工况不同，须按当前工况重新确认，不能沿用上一工况签字',
      });
    }
    const others = signatureRows.filter(
      (sig) => sig.zone === result.zone && sig.proposal !== proposal && sig.decision === 'signed',
    );
    if (others.length && result.signature.status !== 'signed') {
      reminders.push({
        zone: result.zone,
        kind: 'shared-zone-different-scope',
        severity: 'resign',
        message: `${result.zone} 曾按清单 ${sortedUnique(others.map((sig) => sig.proposal)).join('、')} 签过 ${others.map((sig) => sig.receipt).join('、')}`,
        requires: `本次实际物件为 ${result.declared.map((item) => item.item).join('、')}；共用区的其它物件关联同一并用限额，须重新确认，不能以旧签字视为已覆盖`,
      });
    }
    if (result.staleSubmissions.length) {
      reminders.push({
        zone: result.zone,
        kind: 'submission-stale',
        severity: 'resign',
        message: `${result.zone} 有 ${result.staleSubmissions.length} 次送签记录（${result.staleSubmissions.map((record) => record.receipt ?? record.key).join('、')}）所对应的物件、梁、检测或工况已与当前不同`,
        requires: '旧送签不能覆盖变更后的装台包，须按当前装台包重新送签',
      });
    }
  }
  const seenZones = new Set(zoneResults.map((result) => result.zone));
  for (const sig of signatureRows) {
    if (seenZones.has(sig.zone)) continue;
    reminders.push({
      zone: sig.zone,
      kind: 'signed-zone-absent',
      severity: 'info',
      message: `${sig.zone} 签过 ${sig.receipt}（${modeLabel(sig.mode)}，版次 ${sig.plan_rev}），但当前 ${proposal} / ${callId} 清单没有该区物件`,
      requires: '若该区仍在沿用，须按实际物件另送本工况装台包，不能以旧签字视为已确认',
    });
  }
  if (store) {
    const reported = new Set();
    const portalRows = store.portalForVenue(venue.id);
    for (const record of portalRows) {
      if (seenZones.has(record.zone)) {
        if (record.decision === 'signed' && record.mode != null && record.mode !== mode) {
          reminders.push({
            zone: record.zone,
            kind: 'mode-switch',
            severity: 'resign',
            message: `${record.zone} 已按${modeLabel(record.mode)}工况签字（${record.receipt ?? record.key}，${record.proposal} / ${record.call}），现为${modeLabel(mode)}`,
            requires: '场馆确认只覆盖其出具时的分区、工况与版次；切换工况后须重新送签，不能沿用上一工况回执',
          });
        }
        continue;
      }
      if (reported.has(record.zone)) continue;
      reported.add(record.zone);
      reminders.push({
        zone: record.zone,
        kind: 'signed-zone-dropped',
        severity: 'resign',
        message: `${record.zone} 曾按 ${record.proposal} / ${record.call} 送签（${record.receipt ?? record.key}，${record.decision ?? '待回执'}），当前 ${proposal} / ${callId} 清单未包含该区`,
        requires: '已经搭好或已送签的分区不会因换清单或换场次自动消失；须确认撤场或把实际物件纳入新工况',
      });
    }
    for (const pack of store.packsForVenue(venue.id)) {
      for (const zone of pack.zones) {
        if (seenZones.has(zone.zone) || reported.has(zone.zone)) continue;
        reported.add(zone.zone);
        reminders.push({
          zone: zone.zone,
          kind: 'pack-zone-not-in-plan',
          severity: 'info',
          message: `${zone.zone} 属于本机装台包 ${pack.id}（${pack.proposal} / ${pack.call}），当前 ${proposal} / ${callId} 清单没有该区`,
          requires: '若该区仍在沿用，须按实际物件纳入新工况或另送装台包；若已拆下，须由场馆确认撤场',
        });
      }
    }
  }

  const counts = { signed: 0, submitted: 0, conditional: 0, ready: 0, resign: 0, missing: 0, conflict: 0 };
  for (const result of zoneResults) counts[result.status] += 1;
  const handoverHeld = zoneResults.filter((result) => result.handover.status === 'held').length;
  let overall;
  if (counts.conflict) overall = '有冲突待修改';
  else if (counts.missing) overall = counts.signed || counts.ready || counts.conditional || counts.submitted
    ? '部分分区可交签' : '待补资料';
  else if (handoverHeld) overall = '可送签，现场交接挂起';
  else if (counts.resign) overall = '待重签';
  else if (counts.signed) overall = '已签字';
  else overall = '资料齐全';
  if (unplaced.length && !counts.conflict) overall = '有物件未定位承重区';

  return {
    venue: { id: venue.id, name: venue.name, station: venue.station, note: venue.note },
    phase: release.phase,
    revision: release.revision ?? null,
    proposal,
    call,
    callId,
    mode,
    day,
    plans: listPlans(release),
    zones: zoneResults,
    reminders,
    counts,
    handoverHeld,
    overall,
    inspectionPages: release.inspectionPages,
    inspectionIssues: release.inspectionIssues,
    sourceCalls: release.calls,
    conditionalClearingZones: [...conditionalZones],
    basisNote: '只采录场馆发布的吊点—承重区关系、禁用条件、分区并用限额、检测额定值与场馆明示沿用；未做结构补算。',
    signatureRows,
    mounted,
    observations: {
      signatures: store ? store.signaturesForVenue(venue.id) : [],
      portal: store ? store.portalForVenue(venue.id) : [],
    },
  };
}
