import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { SchemaRegistry } from '../src/registry.js';
import { FakeClock } from '../src/clock.js';

const v1 = {
  name: 'OrderEvent',
  fields: [
    { name: 'orderId', type: 'string', required: true },
    { name: 'amount', type: 'long', required: true }
  ]
};

async function withServer() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-http-'));
  const clock = new FakeClock();
  const { registry } = SchemaRegistry.recover({ dir, clock, snapshotEvery: 0 });
  const app = createApp(registry);
  await new Promise((resolve) => app.listen(0, resolve));
  const port = app.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    clock,
    registry,
    close: () =>
      new Promise((resolve) => {
        app.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      })
  };
}

async function call(base, path, options = {}) {
  const res = await fetch(base + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe('HTTP API 端到端', () => {
  let env;
  beforeEach(async () => {
    env = await withServer();
  });
  afterEach(async () => {
    await env.close();
  });

  it('健康检查返回恢复信息与静态页面', async () => {
    const health = await call(env.base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);

    const page = await fetch(env.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /模式注册表/);
  });

  it('完整生命周期：建主题 -> 发布 -> 注册消费者 -> 再发布 -> 写入 -> 窗口阻断', async () => {
    const { base, clock } = env;
    const created = await call(base, '/api/subjects', {
      method: 'POST',
      body: { name: 'orders', compatibilityMode: 'BACKWARD' }
    });
    assert.equal(created.status, 201);

    const pub1 = await call(base, '/api/subjects/orders/versions', {
      method: 'POST',
      body: { schema: v1, compatibilityWindowMs: 60_000 }
    });
    assert.equal(pub1.status, 201);
    assert.equal(pub1.data.version.version, 1);

    const actor = await call(base, '/api/subjects/orders/actors', {
      method: 'POST',
      body: { name: 'p1', role: 'producer', mode: 'BACKWARD', schemaVersion: 1 }
    });
    assert.equal(actor.status, 201);

    // v2 新增可选字段，兼容发布
    const pub2 = await call(base, '/api/subjects/orders/versions', {
      method: 'POST',
      body: {
        schema: {
          name: 'OrderEvent',
          fields: [
            { name: 'orderId', type: 'string' },
            { name: 'amount', type: 'long' },
            { name: 'note', type: 'string', required: false, default: '' }
          ]
        },
        compatibilityWindowMs: 60_000
      }
    });
    assert.equal(pub2.status, 201);

    // 窗口内旧生产者可写
    const write1 = await call(base, '/api/subjects/orders/produce', {
      method: 'POST',
      body: { actor: 'p1', payload: { orderId: 'a', amount: 1 } }
    });
    assert.equal(write1.status, 201);

    // 到期后被阻断，状态码 409
    clock.advance(61_000);
    const blocked = await call(base, '/api/subjects/orders/produce', {
      method: 'POST',
      body: { actor: 'p1', payload: { orderId: 'b', amount: 2 } }
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error, 'OLD_PRODUCER_BLOCKED');

    // 延长窗口后恢复
    const extend = await call(base, '/api/subjects/orders/windows/2/extend', {
      method: 'POST',
      body: { extraMs: 120_000 }
    });
    assert.equal(extend.status, 200);
    const write2 = await call(base, '/api/subjects/orders/produce', {
      method: 'POST',
      body: { actor: 'p1', payload: { orderId: 'c', amount: 3 } }
    });
    assert.equal(write2.status, 201);

    const records = await call(base, '/api/subjects/orders/records');
    assert.equal(records.data.records.length, 2);
  });

  it('发布三闸门通过 HTTP 返回语义化错误码与明细', async () => {
    const { base } = env;
    await call(base, '/api/subjects', {
      method: 'POST',
      body: { name: 'gated' }
    });
    await call(base, '/api/subjects/gated/versions', {
      method: 'POST',
      body: { schema: v1 }
    });
    await call(base, '/api/subjects/gated/ingest', {
      method: 'POST',
      body: { payload: { orderId: 'x', amount: 5 } }
    });

    // 无迁移计划的破坏性发布
    const noPlan = await call(base, '/api/subjects/gated/versions', {
      method: 'POST',
      body: {
        schema: {
          name: 'OrderEvent',
          fields: [
            { name: 'orderId', type: 'string' },
            { name: 'amount', type: 'long' },
            { name: 'tenant', type: 'string' }
          ]
        }
      }
    });
    assert.equal(noPlan.status, 422);
    assert.equal(noPlan.data.error, 'MIGRATION_PLAN_REQUIRED');
    assert.ok(noPlan.data.details.blockingData.length >= 1);

    // 提供覆盖全部 key 的迁移计划后成功
    const withPlan = await call(base, '/api/subjects/gated/versions', {
      method: 'POST',
      body: {
        schema: {
          name: 'OrderEvent',
          fields: [
            { name: 'orderId', type: 'string' },
            { name: 'amount', type: 'long' },
            { name: 'tenant', type: 'string' }
          ]
        },
        migrationPlan: {
          steps: [{ key: 'FIELD_ADDED_REQUIRED:tenant', description: '回填' }]
        }
      }
    });
    assert.equal(withPlan.status, 201);
  });

  it('活跃消费者闸门阻断发布并返回责任消费者', async () => {
    const { base } = env;
    await call(base, '/api/subjects', {
      method: 'POST',
      body: { name: 'consumer-gate' }
    });
    await call(base, '/api/subjects/consumer-gate/versions', {
      method: 'POST',
      body: { schema: v1 }
    });
    await call(base, '/api/subjects/consumer-gate/actors', {
      method: 'POST',
      body: { name: 'strict-c', role: 'consumer', mode: 'FORWARD', schemaVersion: 1 }
    });
    const blocked = await call(base, '/api/subjects/consumer-gate/versions', {
      method: 'POST',
      body: {
        schema: {
          name: 'OrderEvent',
          fields: [
            { name: 'orderId', type: 'string' },
            { name: 'amount', type: 'long' },
            { name: 'tenant', type: 'string' }
          ]
        }
      }
    });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.data.error, 'COMPATIBILITY_VIOLATION');
    assert.equal(blocked.data.details.consumerBlockers[0].actor, 'strict-c');
  });

  it('回滚保留新字段，且不可逆迁移后回滚被 409 拒绝', async () => {
    const { base } = env;
    await call(base, '/api/subjects', { method: 'POST', body: { name: 'rb' } });
    await call(base, '/api/subjects/rb/versions', { method: 'POST', body: { schema: v1 } });
    await call(base, '/api/subjects/rb/versions', {
      method: 'POST',
      body: {
        schema: {
          name: 'OrderEvent',
          fields: [
            { name: 'orderId', type: 'string' },
            { name: 'amount', type: 'long' },
            { name: 'region', type: 'string', required: true, default: 'cn' }
          ]
        }
      }
    });
    await call(base, '/api/subjects/rb/ingest', {
      method: 'POST',
      body: { payload: { orderId: 'o', amount: 1, region: 'us' } }
    });

    const rolled = await call(base, '/api/subjects/rb/rollback', {
      method: 'POST',
      body: { targetVersion: 1 }
    });
    assert.equal(rolled.status, 201);
    assert.deepEqual(rolled.data.retainedFields, ['region']);
    const region = rolled.data.schema.fields.find((f) => f.name === 'region');
    assert.equal(region.required, false);
    assert.equal(region.default, 'cn');

    // 历史记录的新字段仍在
    const records = await call(base, '/api/subjects/rb/records');
    assert.equal(records.data.records[0].payload.region, 'us');

    // 不可逆迁移后再回滚 -> 409
    await call(base, '/api/subjects/rb/migrations', {
      method: 'POST',
      body: { steps: [{ key: 'FIELD_ADDED_REQUIRED:region' }], irreversible: true }
    });
    const denied = await call(base, '/api/subjects/rb/rollback', {
      method: 'POST',
      body: { targetVersion: 1 }
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.data.error, 'IRREVERSIBLE_MIGRATION');
  });

  it('并发 HTTP 发布获得唯一且连续的版本号', async () => {
    const { base } = env;
    await call(base, '/api/subjects', { method: 'POST', body: { name: 'concurrent' } });
    await call(base, '/api/subjects/concurrent/versions', {
      method: 'POST',
      body: { schema: v1 }
    });
    const publishes = [2, 3, 4, 5].map((n) =>
      call(base, '/api/subjects/concurrent/versions', {
        method: 'POST',
        body: {
          schema: {
            name: 'OrderEvent',
            fields: [
              { name: 'orderId', type: 'string' },
              { name: 'amount', type: 'long' },
              { name: `f${n}`, type: 'string', required: false, default: '' }
            ]
          }
        }
      })
    );
    const results = await Promise.all(publishes);
    for (const r of results) assert.equal(r.status, 201);
    const versions = results.map((r) => r.data.version.version).sort((a, b) => a - b);
    assert.deepEqual(versions, [2, 3, 4, 5]);
  });

  it('错误请求与未知资源返回规范错误体', async () => {
    const { base } = env;
    const missing = await call(base, '/api/subjects/ghost');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, 'SUBJECT_NOT_FOUND');

    const badJson = await fetch(base + '/api/subjects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json'
    });
    const body = await badJson.json();
    assert.equal(badJson.status, 422);
    assert.equal(body.error, 'INVALID_REQUEST');
  });
});
