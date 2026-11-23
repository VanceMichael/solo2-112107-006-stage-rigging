import { createHash } from 'node:crypto';

/** Deterministic JSON serialisation used for pack fingerprints. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
    .join(',') + '}';
}

export function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function unique(values) {
  return [...new Set(values)];
}

export function sortedUnique(values) {
  return unique(values).sort((a, b) => String(a).localeCompare(String(b)));
}

export function dateOnly(value) {
  return String(value ?? '').slice(0, 10);
}

export function sumKg(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

export function nowIso() {
  return new Date().toISOString();
}

export function compareDate(left, right) {
  return String(left).localeCompare(String(right));
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function sortByKey(rows, key) {
  return [...rows].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')));
}
