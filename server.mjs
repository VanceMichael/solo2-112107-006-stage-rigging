import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, isPlainObject } from './lib/util.mjs';
import { Store } from './lib/store.mjs';
import { SourceHub } from './lib/source-client.mjs';
import { makeService } from './lib/service.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function reply(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new HttpError(413, '请求过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isPlainObject(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new HttpError(400, '请提交 JSON 对象');
  }
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const target = normalize(join(PUBLIC, relative));
  if (!target.startsWith(PUBLIC + sep)) return false;
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function createApp({ baseUrl = null, storeFile = null, manifest }) {
  const store = new Store(storeFile);
  const hub = new SourceHub({ baseUrl, manifest });
  const service = makeService({ hub, store });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      const served = await serveStatic(req, res, pathname);
      if (!served) reply(res, 404, { message: '页面不存在' });
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/venues') {
        return reply(res, 200, service.venues());
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        return reply(res, 200, service.state());
      }
      let match = /^\/api\/venues\/([A-Za-z0-9_-]+)\/overview$/.exec(pathname);
      if (req.method === 'GET' && match) {
        return reply(res, 200, await service.venueOverview(match[1]));
      }
      match = /^\/api\/venues\/([A-Za-z0-9_-]+)\/analysis$/.exec(pathname);
      if (req.method === 'GET' && match) {
        return reply(res, 200, await service.analysis({
          venue: match[1],
          phase: url.searchParams.get('phase'),
          proposal: url.searchParams.get('proposal'),
          call: url.searchParams.get('call'),
        }));
      }
      match = /^\/api\/venues\/([A-Za-z0-9_-]+)\/packs$/.exec(pathname);
      if (req.method === 'GET' && match) {
        return reply(res, 200, service.packs(match[1]));
      }
      if (req.method === 'POST' && match) {
        const body = await readJson(req);
        return reply(res, 201, await service.buildPack({
          venue: match[1],
          phase: body.phase ?? null,
          proposal: body.proposal,
          call: body.call,
        }));
      }
      match = /^\/api\/venues\/([A-Za-z0-9_-]+)\/submit$/.exec(pathname);
      if (req.method === 'POST' && match) {
        const body = await readJson(req);
        return reply(res, 200, await service.submit({
          venue: match[1],
          pack: body.pack,
          zone: body.zone ?? null,
        }));
      }
      match = /^\/api\/venues\/([A-Za-z0-9_-]+)\/inspect$/.exec(pathname);
      if (req.method === 'POST' && match) {
        const body = await readJson(req);
        return reply(res, 200, await service.inspectPortal({ venue: match[1], key: body.key }));
      }
      match = /^\/api\/venues\/([A-Za-z0-9_-]+)\/packs\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (req.method === 'GET' && match) {
        return reply(res, 200, service.pack(match[2]));
      }
      match = /^\/api\/venues\/([A-Za-z0-9_-]+)\/packs\/([A-Za-z0-9_-]+)\/review$/.exec(pathname);
      if (req.method === 'GET' && match) {
        return reply(res, 200, await service.reviewPack({ venue: match[1], pack: match[2] }));
      }
      reply(res, 404, { message: '接口不存在' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      reply(res, status, { message: error.message, details: error.details ?? null });
    }
  });

  return { server, service, store };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('./wire.json', import.meta.url), 'utf8'));
  const port = Number(process.env.PORT ?? 3000);
  const baseUrl = process.env.SOURCE_URL ?? null;
  const storeFile = process.env.STORE_FILE ?? join(ROOT, 'var', 'store.json');
  const { server } = createApp({ baseUrl, storeFile, manifest });
  server.listen(port, '127.0.0.1', () => {
    console.log(`装台资料门户已启动：http://127.0.0.1:${server.address().port}`);
    console.log(baseUrl ? `来源服务：${baseUrl}` : '来源服务：未配置，M1 直接读取 wire/ 快照');
  });
}
