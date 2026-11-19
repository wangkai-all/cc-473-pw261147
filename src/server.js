import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry } from './registry.js';
import { SystemClock } from './clock.js';
import { ErrorCode, httpStatusFor, RegistryError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'web');

/**
 * 轻量 HTTP 适配层：路由分发 + JSON 编解码，
 * 业务异常统一由 RegistryError.code 映射为语义化状态码。
 */
export function createApp(registry) {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && req.url === '/app.js') {
        return serveStatic(res, 'app.js', 'application/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && req.url === '/styles.css') {
        return serveStatic(res, 'styles.css', 'text/css; charset=utf-8');
      }
      if (!req.url?.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'NOT_FOUND', message: '路径不存在' });
      }
      await route(req, res, registry);
    } catch (err) {
      if (err instanceof RegistryError) {
        return sendJson(res, httpStatusFor(err.code), {
          error: err.code,
          message: err.message,
          details: err.details
        });
      }
      return sendJson(res, 500, {
        error: 'INTERNAL_ERROR',
        message: err.message
      });
    }
  });
}

async function serveStatic(res, file, contentType) {
  const safe = normalize(join(PUBLIC_DIR, file));
  if (!safe.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  const body = await readFile(safe);
  res.writeHead(200, { 'content-type': contentType });
  res.end(body);
}

async function route(req, res, registry) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = await readJson(req);

  // /api/health
  if (req.method === 'GET' && parts.join('/') === 'api/health') {
    return sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      recovery: registry.recoveryInfo
    });
  }

  if (req.method === 'POST' && parts.join('/') === 'api/subjects') {
    return sendJson(res, 201, registry.createSubject(body));
  }
  if (req.method === 'GET' && parts.join('/') === 'api/subjects') {
    return sendJson(res, 200, { subjects: registry.listSubjects() });
  }

  // 此后路径形如 api/subjects/:name/...
  if (parts[1] !== 'subjects' || !parts[2]) {
    return sendJson(res, 404, { error: 'NOT_FOUND', message: '未知接口' });
  }
  const subject = decodeURIComponent(parts[2]);
  const tail = parts.slice(3);

  if (tail.length === 0 && req.method === 'GET') {
    return sendJson(res, 200, registry.describeSubject(subject));
  }

  // api/subjects/:name/actors
  if (tail[0] === 'actors' && tail.length === 1 && req.method === 'POST') {
    const actor = await registry.registerActor(subject, body);
    return sendJson(res, 201, actor);
  }
  if (tail[0] === 'actors' && tail.length === 2 && req.method === 'DELETE') {
    await registry.deregisterActor(subject, decodeURIComponent(tail[1]));
    return sendJson(res, 200, { deregistered: tail[1] });
  }
  if (tail[0] === 'actors' && tail.length === 3 && tail[2] === 'heartbeat' && req.method === 'POST') {
    return sendJson(res, 200, await registry.heartbeat(subject, decodeURIComponent(tail[1])));
  }

  // api/subjects/:name/versions
  if (tail[0] === 'versions' && tail.length === 1 && req.method === 'POST') {
    const result = await registry.registerVersion(subject, body.schema, {
      publishedBy: body.publishedBy,
      compatibilityWindowMs: body.compatibilityWindowMs,
      migrationPlan: body.migrationPlan ?? null
    });
    return sendJson(res, 201, result);
  }
  if (tail[0] === 'versions' && tail.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, registry.getVersion(subject, Number(tail[1])));
  }

  // 写入与查询
  if (tail[0] === 'produce' && tail.length === 1 && req.method === 'POST') {
    return sendJson(res, 201, await registry.produce(subject, body.actor, body.payload));
  }
  if (tail[0] === 'ingest' && tail.length === 1 && req.method === 'POST') {
    return sendJson(
      res,
      201,
      await registry.ingestRecord(subject, body.payload, {
        schemaVersion: body.schemaVersion,
        writtenBy: body.writtenBy
      })
    );
  }
  if (tail[0] === 'records' && tail.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, { records: registry.listRecords(subject) });
  }

  // 迁移与窗口
  if (tail[0] === 'migrations' && tail.length === 1 && req.method === 'POST') {
    return sendJson(
      res,
      200,
      await registry.applyMigration(subject, body.steps, { irreversible: Boolean(body.irreversible) })
    );
  }
  if (tail[0] === 'windows' && tail.length === 3 && tail[2] === 'extend' && req.method === 'POST') {
    return sendJson(
      res,
      200,
      await registry.extendWindow(subject, Number(tail[1]), Number(body.extraMs))
    );
  }

  // 回滚
  if (tail[0] === 'rollback' && tail.length === 1 && req.method === 'POST') {
    return sendJson(
      res,
      201,
      await registry.rollback(subject, Number(body.targetVersion), {
        compatibilityWindowMs: body.compatibilityWindowMs
      })
    );
  }

  return sendJson(res, 404, { error: 'NOT_FOUND', message: '未知接口' });
}

async function readJson(req) {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RegistryError(ErrorCode.INVALID_REQUEST, '请求体不是合法 JSON');
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

export function startServer({
  dataDir = process.env.SCHEMA_REGISTRY_DATA || join(process.cwd(), 'data'),
  port = Number(process.env.PORT) || 3000
} = {}) {
  const { registry, recovery } = SchemaRegistry.recover({
    dir: dataDir,
    clock: new SystemClock()
  });
  const server = createApp(registry);
  return new Promise((resolve) => {
    server.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(
        `[schema-registry] 监听 http://localhost:${port}，数据目录 ${dataDir}，` +
          `恢复事件 ${recovery.replayed} 条${recovery.recoveredPartial ? '（含半写尾部已修复）' : ''}`
      );
      resolve({ server, registry, recovery });
    });
  });
}

// 直接运行时启动服务
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
