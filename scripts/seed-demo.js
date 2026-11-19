/**
 * 演示数据种子：通过内存注册表构造一个包含多版本、多参与者、
 * 窗口到期与回滚的完整场景，并持久化到 data/ 目录。
 *
 * 运行：node scripts/seed-demo.js
 */
import { rmSync } from 'node:fs';
import { SchemaRegistry } from '../src/registry.js';
import { FakeClock } from '../src/clock.js';
import { CompatibilityMode } from '../src/compatibility.js';

const DATA_DIR = new URL('../data', import.meta.url).pathname;

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  // 固定起点：2026-11-01，便于演示窗口倒计时
  const clock = new FakeClock(Date.parse('2026-11-01T00:00:00Z'));
  const { registry } = SchemaRegistry.recover({
    dir: DATA_DIR,
    clock,
    snapshotEvery: 0
  });

  registry.createSubject({
    name: 'order-events',
    compatibilityMode: CompatibilityMode.BACKWARD
  });

  // v1 初始模式
  await registry.registerVersion(
    'order-events',
    {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string', required: true },
        { name: 'amount', type: 'long', required: true }
      ]
    },
    { publishedBy: 'platform-team', compatibilityWindowMs: 14 * 86_400_000 }
  );

  // 旧版生产者与不同策略的消费者
  await registry.registerActor('order-events', {
    name: 'checkout-producer',
    role: 'producer',
    mode: CompatibilityMode.BACKWARD,
    schemaVersion: 1
  });
  await registry.registerActor('order-events', {
    name: 'billing-consumer',
    role: 'consumer',
    mode: CompatibilityMode.FORWARD,
    schemaVersion: 1
  });
  await registry.registerActor('order-events', {
    name: 'warehouse-consumer',
    role: 'consumer',
    mode: CompatibilityMode.FULL,
    schemaVersion: 1
  });

  // 写入两条 v1 存量数据
  await registry.produce('order-events', 'checkout-producer', {
    orderId: 'o-1001',
    amount: 2500
  });
  await registry.produce('order-events', 'checkout-producer', {
    orderId: 'o-1002',
    amount: 980
  });

  // v2：新增可选带默认值字段（兼容发布），窗口 7 天
  clock.advance(2 * 86_400_000);
  await registry.registerVersion(
    'order-events',
    {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string', required: true },
        { name: 'amount', type: 'long', required: true },
        { name: 'currency', type: 'string', required: false, default: 'CNY' }
      ]
    },
    { publishedBy: 'platform-team', compatibilityWindowMs: 7 * 86_400_000 }
  );

  // v3：新增带默认值的 tenant（对各策略消费者均兼容），窗口 5 天
  clock.advance(3 * 86_400_000);
  await registry.registerVersion(
    'order-events',
    {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string', required: true },
        { name: 'amount', type: 'long', required: true },
        { name: 'currency', type: 'string', required: false, default: 'CNY' },
        { name: 'tenant', type: 'string', required: false, default: 'default-tenant' }
      ]
    },
    {
      publishedBy: 'platform-team',
      compatibilityWindowMs: 5 * 86_400_000
    }
  );

  // 登记一次针对历史数据的回填迁移（可逆，保留回滚能力）
  await registry.applyMigration('order-events', [
    {
      key: 'FIELD_ADDED_REQUIRED:tenant',
      description: '历史订单统一回填默认租户 default-tenant',
      transformation: "tenant = coalesce(tenant, 'default-tenant')"
    }
  ]);

  // 已升级的新生产者
  await registry.registerActor('order-events', {
    name: 'checkout-producer-v3',
    role: 'producer',
    mode: CompatibilityMode.BACKWARD,
    schemaVersion: 3
  });
  await registry.heartbeat('order-events', 'billing-consumer');

  // 再建一个主题演示回滚场景
  registry.createSubject({ name: 'payment-events' });
  await registry.registerVersion('payment-events', {
    name: 'PaymentEvent',
    fields: [{ name: 'paymentId', type: 'string', required: true }]
  });
  await registry.registerVersion('payment-events', {
    name: 'PaymentEvent',
    fields: [
      { name: 'paymentId', type: 'string', required: true },
      { name: 'riskScore', type: 'int', required: true, default: 0 }
    ]
  });
  await registry.ingestRecord('payment-events', {
    paymentId: 'p-1',
    riskScore: 42
  });
  await registry.rollback('payment-events', 1);

  registry.checkpoint();

  console.log('演示数据已写入', DATA_DIR);
  console.log('主题：order-events（v3，含迁移计划）、payment-events（已回滚至 v1 并保留 riskScore）');
  console.log('启动服务：npm start，然后访问 http://localhost:3000');
}

main().catch((err) => {
  console.error('种子写入失败：', err);
  process.exitCode = 1;
});
