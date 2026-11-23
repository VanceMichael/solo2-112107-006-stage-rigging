import { readFileSync } from 'node:fs';
import { HttpError, isPlainObject } from './util.mjs';

export const WIRE_PHASES = ['opening', 'interim', 'confirmed'];
const TIMEOUT_MS = 4000;

function loadJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

function safeName(value) {
  return /^[a-z0-9-]+$/.test(String(value));
}

/**
 * Reads venue releases and writes venue portal requests.
 *
 * M1 is published by the synthetic HTTP source (or straight from `wire/` when
 * no base URL is configured). M2 is a local venue release under `data/m2/`,
 * deliberately separate from M1 so the next tour stop cannot reuse the
 * previous venue's limits, certificates or signatures.
 */
export class SourceHub {
  constructor({ baseUrl = null, manifest, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
    this.manifest = manifest;
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
    this.localRequests = new Map();
    this.localPortalConfig = new Map();
  }

  async get(venue, phase, resource) {
    if (venue.source === 'wire') return this.getWire(venue, phase, resource);
    if (venue.source === 'local') return this.getLocal(venue, phase, resource);
    throw new HttpError(400, `未知来源类型：${venue.source}`);
  }

  async getWire(venue, phase, resource) {
    if (!WIRE_PHASES.includes(phase)) throw new HttpError(400, `未知阶段：${phase}`);
    const cacheKey = [venue.id, phase, resource].join('/');
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const promise = (async () => {
      if (!this.baseUrl) {
        const entry = this.manifest.releases?.[phase]?.[resource];
        if (!entry) throw new HttpError(404, '发布方尚未交付此页');
        if (entry.status) throw new HttpError(entry.status, '发布方暂不可用');
        return loadJson(new URL('../wire/' + entry.name, import.meta.url));
      }
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/${phase}/${resource}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new HttpError(503, `来源不可达：${phase}/${resource}`, { cause: String(error.message) });
      }
      if (!response.ok) {
        let message = `来源返回 ${response.status}`;
        try {
          const body = await response.json();
          if (body?.message) message = body.message;
        } catch { /* keep status */ }
        throw new HttpError(response.status, message, { phase, resource });
      }
      return response.json();
    })();

    this.cache.set(cacheKey, promise);
    promise.catch(() => this.cache.delete(cacheKey));
    return promise;
  }

  async getLocal(venue, phase, resource) {
    const phases = venue.phases ?? ['confirmed'];
    if (!phases.includes(phase)) throw new HttpError(400, `本站资料仅有 ${phases.join('、')} 版`);
    if (!safeName(resource)) throw new HttpError(404, '资源不存在');
    try {
      return loadJson(new URL(`../data/${venue.dir}/${resource}.json`, import.meta.url));
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, '当地场馆尚未发布此页');
      throw error;
    }
  }

  /**
   * Posts a portal request. Wire venues go to the synthetic HTTP service when
   * configured; otherwise (and for local venues) the same request grammar is
   * served locally so a station can be prepared offline. Request/replay/conflict
   * and late-receipt semantics match the upstream service.
   */
  async postPortal(venue, phase, payload) {
    if (venue.source === 'wire' && this.baseUrl) return this.postRemote(phase, payload);
    return this.postLocal(venue, phase, payload);
  }

  async postRemote(phase, payload) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/${phase}/portal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new HttpError(503, '门户不可达', { cause: String(error.message) });
    }
    let body = null;
    try { body = await response.json(); } catch { /* empty body */ }
    if (!response.ok) {
      throw new HttpError(response.status, body?.message ?? `门户返回 ${response.status}`, { body });
    }
    return body;
  }

  portalConfig(venue) {
    if (this.localPortalConfig.has(venue.id)) return this.localPortalConfig.get(venue.id);
    let config;
    if (venue.source === 'local') {
      config = loadJson(new URL(`../data/${venue.dir}/portal.json`, import.meta.url));
    } else {
      config = {
        actions: this.manifest.actions,
        inspectStates: this.manifest.inspectStates,
        statusField: this.manifest.statusField,
        lateAction: this.manifest.lateAction,
      };
    }
    this.localPortalConfig.set(venue.id, config);
    return config;
  }

  postLocal(venue, phase, payload) {
    const config = this.portalConfig(venue);
    const action = payload?.action;
    const key = payload?.key;
    if (typeof key !== 'string' || !key.trim() || !Object.hasOwn(config.actions, action)) {
      throw new HttpError(422, '无有效请求号或操作');
    }
    const storeKey = venue.id + '|' + key;
    const previous = this.localRequests.get(storeKey);

    if (action === 'inspect') {
      if (!previous) throw new HttpError(404, '门户未收到此请求');
      const { input, operation, ...output } = previous;
      const confirmedState = config.inspectStates?.[operation];
      if (phase === 'confirmed' && confirmedState) output[config.statusField] = confirmedState;
      return { key, ...output };
    }

    const input = JSON.stringify(payload);
    if (previous) {
      if (previous.input !== input) throw new HttpError(409, '请求号已对应其他报文');
      const { input: ignored, operation, ...output } = previous;
      return { key, ...output };
    }
    const response = { ...config.actions[action], sourceRef: `${venue.id}-${phase}-${this.localRequests.size + 1}` };
    this.localRequests.set(storeKey, { ...response, input, operation: action });
    if (phase === 'interim' && config.lateAction === action) {
      throw new HttpError(503, '门户未能及时回传回执');
    }
    return { key, ...response };
  }
}

/** Fetches a full release, recording each page's outcome. */
export async function collectRelease(hub, venue, phase) {
  const index = await hub.get(venue, phase, 'floor-index');
  if (!isPlainObject(index)) throw new HttpError(502, `${phase} 的 floor-index 不是对象`);
  const base = ['calls', 'zones', 'points', 'set', 'signatures', 'inheritance', 'mounted'];
  const inspectionPages = Array.isArray(index.inspectionPages) ? index.inspectionPages : [];
  const resources = [...base, ...inspectionPages];

  const pages = { 'floor-index': index };
  const log = [{ phase, resource: 'floor-index', ok: true, status: 200 }];
  await Promise.all(resources.map(async (resource) => {
    try {
      pages[resource] = await hub.get(venue, phase, resource);
      log.push({ phase, resource, ok: true, status: 200 });
    } catch (error) {
      pages[resource] = null;
      log.push({ phase, resource, ok: false, status: error.status ?? 502, message: error.message });
    }
  }));

  log.sort((a, b) => a.resource.localeCompare(b.resource));
  const inspections = [];
  for (const page of inspectionPages) {
    if (Array.isArray(pages[page])) {
      for (const row of pages[page]) inspections.push({ ...row, page });
    }
  }
  return {
    venue,
    phase,
    revision: index.revision ?? null,
    index,
    inspectionPages,
    pages,
    sourceCalls: log,
    inspections,
    inspectionIssues: log.filter((call) => !call.ok && inspectionPages.includes(call.resource)),
    calls: Array.isArray(pages.calls) ? pages.calls : [],
    zones: Array.isArray(pages.zones) ? pages.zones : [],
    points: Array.isArray(pages.points) ? pages.points : [],
    set: Array.isArray(pages.set) ? pages.set : [],
    signatures: Array.isArray(pages.signatures) ? pages.signatures : [],
    inheritance: Array.isArray(pages.inheritance) ? pages.inheritance : [],
    mounted: Array.isArray(pages.mounted) ? pages.mounted : [],
  };
}
