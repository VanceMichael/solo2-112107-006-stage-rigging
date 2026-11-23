import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './util.mjs';

const EMPTY = () => ({ version: 1, signatures: {}, portal: {}, packs: {}, counters: { pack: 0 } });

/**
 * Durable observation store.
 *
 * Venue releases are read-only snapshots. Everything this app adds is kept
 * here: the first scope a venue receipt was seen to cover, every pack submitted
 * through the portal and its receipt, and local pack numbering. That lets a
 * later mode, beam, item or load change be detected instead of silently
 * reusing an old confirmation.
 */
export class Store {
  constructor(file = null) {
    this.file = file;
    this.data = EMPTY();
    if (file) {
      try {
        this.data = { ...EMPTY(), ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = this.file + '.' + process.pid + '.tmp';
    writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n');
    renameSync(temp, this.file);
  }

  signatureKey(venue, receipt) {
    return [venue, receipt].join('|');
  }

  /**
   * Notes a source signature's scope. A scope baseline is only supplied when
   * the signature's own declared fields (revision, mode, zone, certificates)
   * already line up with the analysed release; a changed condition must never
   * become the baseline it is later compared against.
   */
  observeSignature({ venue, phase, signature, baseline = null }) {
    const key = this.signatureKey(venue, signature.receipt);
    const previous = this.data.signatures[key] ?? null;
    const record = {
      venue,
      receipt: signature.receipt,
      proposal: signature.proposal ?? null,
      zone: signature.zone ?? null,
      mode: signature.mode ?? null,
      plan_rev: signature.plan_rev ?? null,
      inspection_ids: [...(signature.inspection_ids ?? [])].sort(),
      decision: signature.decision ?? null,
      firstSeen: previous?.firstSeen ?? nowIso(),
      lastSeen: nowIso(),
      phases: [...new Set([...(previous?.phases ?? []), phase])],
      scopeDigest: previous?.scopeDigest ?? null,
      baselineFacts: previous?.baselineFacts ?? null,
      baselineRevision: previous?.baselineRevision ?? null,
    };
    if (!record.scopeDigest && baseline) {
      record.scopeDigest = baseline.scopeDigest;
      record.baselineFacts = baseline.facts;
      record.baselineRevision = baseline.revision ?? null;
    }
    this.data.signatures[key] = record;
    this.save();
    return record;
  }

  signatureRecord(venue, receipt) {
    return this.data.signatures[this.signatureKey(venue, receipt)] ?? null;
  }

  signaturesForVenue(venue) {
    return Object.values(this.data.signatures)
      .filter((record) => record.venue === venue)
      .sort((a, b) => String(a.receipt).localeCompare(String(b.receipt)));
  }

  putPortal(record) {
    const previous = this.data.portal[record.key] ?? null;
    this.data.portal[record.key] = {
      ...previous,
      ...record,
      createdAt: previous?.createdAt ?? record.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    this.save();
    return this.data.portal[record.key];
  }

  portalRecord(key) {
    return this.data.portal[key] ?? null;
  }

  portalForVenue(venue) {
    return Object.values(this.data.portal)
      .filter((record) => record.venue === venue)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  portalForZone(venue, zone) {
    return this.portalForVenue(venue).filter((record) => record.zone === zone);
  }

  putPack(pack) {
    this.data.packs[pack.id] = pack;
    this.save();
    return pack;
  }

  pack(id) {
    return this.data.packs[id] ?? null;
  }

  packsForVenue(venue) {
    return Object.values(this.data.packs)
      .filter((pack) => pack.venue?.id === venue)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  nextPackNumber() {
    this.data.counters.pack = (this.data.counters.pack ?? 0) + 1;
    this.save();
    return this.data.counters.pack;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
}
