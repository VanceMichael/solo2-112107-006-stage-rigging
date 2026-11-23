import { HttpError, digest, nowIso } from './util.mjs';
import { analyze, modeLabel, seedSignatureBaselines } from './engine.mjs';
import { collectRelease } from './source-client.mjs';
import { getVenue, previousVenues, venuePhases, defaultPhase, VENUES } from './venues.mjs';

const PHASE_PREFERENCE = ['confirmed', 'interim', 'opening'];

function publicVenue(venue) {
  return {
    id: venue.id,
    name: venue.name,
    station: venue.station,
    note: venue.note,
    phases: venuePhases(venue),
    defaultPhase: defaultPhase(venue),
  };
}

/**
 * Application service: release collection, analysis, pack building, portal
 * submission and post-change review. It holds no HTTP concerns.
 */
export function makeService({ hub, store }) {
  const cache = new Map();

  const requireVenue = (id) => {
    const venue = getVenue(id);
    if (!venue) throw new HttpError(404, `未知场馆：${id}`);
    return venue;
  };

  const phasesOf = (venue) => venuePhases(venue);

  function pickPhase(venue, phase) {
    if (phase) {
      if (!phasesOf(venue).includes(phase)) throw new HttpError(422, `场馆 ${venue.id} 没有 ${phase} 期资料`);
      return phase;
    }
    if (venue.defaultPhase) return venue.defaultPhase;
    const preferred = PHASE_PREFERENCE.find((name) => phasesOf(venue).includes(name));
    return preferred ?? phasesOf(venue)[0];
  }

  function release(venue, phase) {
    const key = venue.id + '/' + phase;
    if (!cache.has(key)) {
      const promise = collectRelease(hub, venue, phase);
      promise.catch(() => cache.delete(key));
      cache.set(key, promise);
    }
    return cache.get(key);
  }

  async function allReleases(venue) {
    const rows = [];
    for (const phase of phasesOf(venue)) {
      try {
        rows.push(await release(venue, phase));
      } catch { /* a missing phase contributes no baseline */ }
    }
    return rows;
  }

  function organise(rel) {
    const calls = new Map(rel.calls.map((call) => [call.call, call]));
    const points = new Map(rel.points.map((point) => [point.point, point]));
    const plans = new Map();
    for (const row of rel.set) {
      const key = row.proposal + '/' + row.call;
      if (!plans.has(key)) {
        plans.set(key, {
          key,
          proposal: row.proposal,
          call: row.call,
          mode: calls.get(row.call)?.kind ?? null,
          opens: calls.get(row.call)?.opens ?? null,
          venue: calls.get(row.call)?.venue ?? null,
          items: 0,
          zones: new Set(),
          kg: 0,
        });
      }
      const plan = plans.get(key);
      plan.items += 1;
      if (Number.isFinite(row.kg)) plan.kg += row.kg;
      const zone = points.get(row.point)?.zone;
      if (zone) plan.zones.add(zone);
    }
    return [...plans.values()]
      .map((plan) => ({
        ...plan,
        zones: [...plan.zones].sort(),
        own: plan.venue === null || plan.venue === rel.venue.id,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async function analyse(venue, phase, proposal, call) {
    const rel = await release(venue, phase);
    seedSignatureBaselines({ store, venue, releases: await allReleases(venue) });
    const result = analyze({ venue, release: rel, proposal, callId: call, store });
    if (result.error) throw new HttpError(422, result.error);
    return { rel, result };
  }

  function previousPackSummaries(venue) {
    return previousVenues(venue.id).flatMap((previous) => store.packsForVenue(previous.id).map((pack) => ({
      id: pack.id,
      venue: previous.id,
      venueName: previous.name,
      station: previous.station,
      proposal: pack.proposal,
      call: pack.call,
      mode: pack.mode,
      revision: pack.revision,
      createdAt: pack.createdAt,
      zones: pack.zones.map((zone) => zone.zone),
      status: pack.status,
      confirmedZones: pack.zones.filter((zone) => zone.signature?.status === 'signed').map((zone) => zone.zone),
    })));
  }

  return {
    venues() {
      return VENUES.map(publicVenue);
    },

    async venueOverview(venueId) {
      const venue = requireVenue(venueId);
      const phases = [];
      for (const phase of phasesOf(venue)) {
        try {
          const rel = await release(venue, phase);
          phases.push({
            phase,
            revision: rel.revision,
            plans: organise(rel).filter((plan) => plan.own),
            inspectionPages: rel.inspectionPages,
            inspectionIssues: rel.inspectionIssues,
            sourceCalls: rel.sourceCalls,
            conditionalClearingZones: rel.index.conditionalClearingZones ?? [],
            calls: rel.calls,
          });
        } catch (error) {
          phases.push({ phase, error: error.message, status: error.status ?? 502 });
        }
      }
      return {
        venue: publicVenue(venue),
        phases,
        previous: previousVenues(venue.id).map((previous) => ({
          ...publicVenue(previous),
          packs: store.packsForVenue(previous.id).slice(0, 5),
        })),
      };
    },

    async analysis({ venue: venueId, phase = null, proposal, call }) {
      const venue = requireVenue(venueId);
      const chosen = pickPhase(venue, phase);
      const { rel, result } = await analyse(venue, chosen, proposal, call);
      return {
        ...result,
        venue: publicVenue(venue),
        phases: phasesOf(venue),
        requestedPhase: phase,
        phase: chosen,
        previousPacks: previousPackSummaries(venue),
        localPacks: store.packsForVenue(venue.id).map((pack) => ({
          id: pack.id,
          proposal: pack.proposal,
          call: pack.call,
          revision: pack.revision,
          createdAt: pack.createdAt,
          status: pack.status,
          zones: pack.zones.map((zone) => ({ zone: zone.zone, status: zone.status })),
        })),
      };
    },

    /** Builds a signable pack. Conflicts are retained, never auto-resolved. */
    async buildPack({ venue: venueId, phase = null, proposal, call }) {
      const venue = requireVenue(venueId);
      const chosen = pickPhase(venue, phase);
      const { result } = await analyse(venue, chosen, proposal, call);
      const number = store.nextPackNumber();
      const id = `PACK-${venue.id}-${String(number).padStart(3, '0')}`;
      const pack = {
        id,
        venue: publicVenue(venue),
        phase: chosen,
        revision: result.revision,
        proposal,
        call,
        mode: result.mode,
        modeLabel: modeLabel(result.mode),
        opens: result.call.opens,
        createdAt: nowIso(),
        basisNote: result.basisNote,
        overall: result.overall,
        needsHumanReview: result.zones.some((zone) => zone.conflicts.length) || result.reminders.some((row) => row.severity === 'resign' || row.severity === 'action'),
        zones: result.zones.map((zone) => ({
          zone: zone.zone,
          mode: zone.mode,
          limitKg: zone.limitKg,
          declared: zone.declared.map((item) => ({
            item: item.item,
            point: item.point,
            beam: item.beam,
            kg: item.kg,
            group: item.group,
            inspection: { link: item.inspection.link, ids: item.inspection.ids, basis: item.inspection.basis },
          })),
          groups: zone.groups,
          totalDeclaredKg: zone.totalDeclaredKg,
          retained: zone.retainedExtra,
          reDeclared: zone.reDeclared,
          retainedKg: zone.retainedKg,
          totalActualKg: zone.totalActualKg,
          conditionalClearing: zone.conditionalClearing,
          inspections: zone.inspections,
          certificates: zone.certificates,
          fingerprint: zone.scopeDigest,
          facts: zone.facts,
          conflicts: zone.conflicts,
          conflictsForReview: zone.conflicts.filter((row) => row.blocking === false),
          missing: zone.missing,
          status: zone.status,
          statusLabel: zone.statusLabel,
          submitAllowed: zone.submitAllowed,
          submitScope: zone.submitScope,
          handover: zone.handover,
          signature: zone.signature,
        })),
        reminders: result.reminders,
        status: 'draft',
        submissions: [],
      };
      pack.digest = digest(pack);
      store.putPack(pack);
      return pack;
    },

    pack(id) {
      const pack = store.pack(id);
      if (!pack) throw new HttpError(404, '未找到该装台包');
      return pack;
    },

    packs(venueId) {
      requireVenue(venueId);
      return store.packsForVenue(venueId);
    },

    /** Sends the pack (or one zone of it) to the venue portal. */
    async submit({ venue: venueId, pack: packId, zone: zoneName = null }) {
      const venue = requireVenue(venueId);
      const pack = store.pack(packId);
      if (!pack) throw new HttpError(404, '未找到该装台包');
      if (pack.venue.id !== venueId) throw new HttpError(422, '装台包不属于该场馆');
      const targets = pack.zones.filter((zone) => (zoneName ? zone.zone === zoneName : true));
      if (!targets.length) throw new HttpError(422, '装台包中没有可送签的分区');

      // The venue confirms exactly what the pack declares, including the
      // release revision it was built from ("按装台包适用的分区、工况和资料版次").
      // A newer publication does not retroactively cover an older pack; the
      // post-change review reports that instead.
      const phase = pickPhase(venue, pack.phase);

      const results = [];
      for (const zone of targets) {
        const blockers = [
          ...zone.conflicts.map((row) => row.message),
          ...zone.missing.map((row) => (row.reasons ?? []).join('；')),
        ];
        if (!zone.submitAllowed) {
          results.push({
            zone: zone.zone,
            accepted: false,
            status: 409,
            message: '该区仍有冲突或缺失资料，不能送签；冲突须修改后交人工复核',
            reasons: blockers,
          });
          continue;
        }
        const facts = {
          zone: zone.zone,
          mode: zone.mode,
          proposal: pack.proposal,
          plan_rev: pack.proposal,
          release: pack.revision,
          pack: pack.id,
          fingerprint: zone.fingerprint,
          declarations: zone.declared.map((item) => ({
            item: item.item,
            point: item.point,
            beam: item.beam,
            kg: item.kg,
            group: item.group,
            inspection: item.inspection.ids,
          })),
          retained: zone.retained,
          inspections: zone.inspections,
          submit_scope: zone.submitScope,
          clearing_conditional: zone.conditionalClearing,
        };
        // Pack, zone, release revision and fingerprint form a natural request
        // id: retrying an unacknowledged send replays it instead of creating a
        // second request, while any material change yields a new key.
        const key = `pack-${pack.id}-${zone.zone}-${pack.revision}-${String(zone.fingerprint).slice(0, 12)}`;
        const previousRecord = store.portalRecord(key);
        if (previousRecord?.portalState === 'accepted') {
          results.push({
            zone: zone.zone,
            accepted: true,
            key,
            replayed: true,
            reply: { receipt: previousRecord.receipt, sourceRef: previousRecord.sourceRef, decision: previousRecord.decision },
            record: previousRecord,
          });
          continue;
        }
        let reply;
        try {
          reply = await hub.postPortal(venue, phase, { action: 'send', key, facts });
        } catch (error) {
          if (error.status === 409) throw error;
          const retryable = error.status === 503;
          store.putPortal({
            key,
            venue: venue.id,
            zone: zone.zone,
            proposal: pack.proposal,
            call: pack.call,
            pack: pack.id,
            fingerprint: zone.fingerprint,
            phase,
            mode: zone.mode,
            decision: 'submit-failed',
            portalState: retryable ? 'unavailable' : 'rejected',
            error: error.message,
            facts,
          });
          results.push({
            zone: zone.zone,
            accepted: false,
            status: error.status ?? 500,
            message: error.message,
            retryable,
          });
          continue;
        }
        const record = store.putPortal({
          key,
          venue: venue.id,
          zone: zone.zone,
          proposal: pack.proposal,
          call: pack.call,
          pack: pack.id,
          fingerprint: zone.fingerprint,
          phase,
          mode: zone.mode,
          receipt: reply?.receipt ?? null,
          sourceRef: reply?.sourceRef ?? null,
          decision: reply?.decision ?? null,
          portalState: 'accepted',
          facts,
        });
        results.push({ zone: zone.zone, accepted: true, key, reply, record });
      }

      const stored = store.pack(pack.id);
      if (stored) {
        const accepted = results.filter((row) => row.accepted && !row.replayed);
        stored.submissions = [
          ...(stored.submissions ?? []),
          ...accepted.map((row) => ({
            zone: row.zone,
            key: row.key,
            receipt: row.reply?.receipt ?? null,
            sourceRef: row.reply?.sourceRef ?? null,
            at: nowIso(),
          })),
        ];
        for (const row of accepted) {
          const zone = stored.zones.find((entry) => entry.zone === row.zone);
          if (zone) {
            zone.submissions = [
              ...(zone.submissions ?? []),
              { key: row.key, receipt: row.reply?.receipt ?? null, decision: row.reply?.decision ?? null, at: nowIso() },
            ];
          }
        }
        stored.status = stored.submissions.length ? 'submitted' : stored.status;
        store.putPack(stored);
      }
      return {
        pack: pack.id,
        accepted: results.filter((row) => row.accepted).length,
        rejected: results.filter((row) => !row.accepted).length,
        results,
      };
    },

    /**
     * Queries a previously sent request. Venue decisions are published in the
     * venue's later release, so an accepted request is inspected against the
     * venue's current (final) release, not the release it was sent under.
     */
    async inspectPortal({ venue: venueId, key }) {
      const venue = requireVenue(venueId);
      const record = store.portalRecord(key);
      if (!record || record.venue !== venueId) throw new HttpError(404, '本地没有该请求记录');
      // The venue publishes its decision in a later release; query the venue's
      // current release so a confirmed receipt is not stuck at "received".
      const phase = pickPhase(venue, null);
      try {
        const reply = await hub.postPortal(venue, phase, { action: 'inspect', key });
        return store.putPortal({
          ...record,
          receipt: reply.receipt ?? record.receipt,
          sourceRef: reply.sourceRef ?? record.sourceRef,
          decision: reply.decision ?? record.decision,
          portalState: 'accepted',
          inspectedAt: nowIso(),
        });
      } catch (error) {
        if (error.status === 503) {
          store.putPortal({ ...record, portalState: 'unavailable', inspectedAt: nowIso() });
          throw new HttpError(503, '门户暂不可用，保留上一次回执状态');
        }
        throw error;
      }
    },

    /**
     * Re-analyses a submitted pack against the current release. The pack's own
     * fingerprint is the baseline: an unchanged zone keeps its receipt, any
     * change reopens it, and a zone that vanished from the new list is reported
     * rather than treated as cleared.
     */
    async reviewPack({ venue: venueId, pack: packId }) {
      const venue = requireVenue(venueId);
      const pack = store.pack(packId);
      if (!pack) throw new HttpError(404, '未找到该装台包');
      const latestPhase = pickPhase(venue, null);
      const latestRelease = await release(venue, latestPhase);
      const comparisonPhase = latestRelease.set.some(
        (row) => row.proposal === pack.proposal && row.call === pack.call,
      ) ? latestPhase : pack.phase;
      const { result } = await analyse(venue, comparisonPhase, pack.proposal, pack.call);
      const superseded = comparisonPhase === latestPhase ? null
        : `装台包所用清单 ${pack.proposal} / ${pack.call} 不在场馆 ${latestPhase} 版次中；以下对照基于出具时的 ${pack.phase} 版次，清单本身须按当前发布重办`;

      const comparisons = result.zones.map((zone) => {
        const submitted = pack.zones.find((row) => row.zone === zone.zone);
        if (!submitted) {
          return { zone: zone.zone, state: 'new-in-plan', message: '当前清单新增了该区，须另送签', signature: zone.signature };
        }
        if (submitted.fingerprint === zone.scopeDigest) {
          return { zone: zone.zone, state: 'unchanged', message: '与送签时逐项一致，签字范围仍完全适用', signature: zone.signature };
        }
        return {
          zone: zone.zone,
          state: 'changed',
          message: '与送签时相比条件已变，须重新确认',
          changes: result.reminders.filter((row) => row.zone === zone.zone),
          signature: zone.signature,
        };
      });
      const dropped = pack.zones
        .filter((row) => !result.zones.some((zone) => zone.zone === row.zone))
        .map((row) => ({
          zone: row.zone,
          state: 'absent-from-plan',
          message: '该区不再出现在当前清单，但现场仍可能留存；不能自动视为撤场',
        }));
      return {
        pack: pack.id,
        venue: publicVenue(venue),
        revision: result.revision,
        comparisonPhase,
        latestPhase,
        superseded,
        mode: result.mode,
        comparisons,
        dropped,
        reminders: result.reminders,
        overall: result.overall,
      };
    },

    state() {
      return store.snapshot();
    },
  };
}
