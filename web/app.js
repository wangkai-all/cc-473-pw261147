/* 全局状态 */
let subjects = [];
let currentSubject = null;
let refreshTimer = null;
let countdownTimer = null;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `请求失败 ${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

/* ---------- Toast ---------- */

function toast(title, detail, kind = 'success') {
  const host = $('#toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${
    detail ? `<pre>${esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2))}</pre>` : ''
  }`;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4000);
}

/* ---------- 徽章与时间 ---------- */

function compatBadge(compatible, label) {
  const cls = compatible ? 'good' : 'critical';
  const text = compatible ? `${label} · 兼容` : `${label} · 破坏`;
  return `<span class="badge ${cls}" title="${esc(text)}">${esc(text)}</span>`;
}

function stateBadge(actor) {
  if (!actor.active) return `<span class="badge neutral">已注销</span>`;
  if (actor.blockedNow) return `<span class="badge critical">写入已阻断</span>`;
  if (actor.behindLatest) return `<span class="badge warn">落后最新版</span>`;
  return `<span class="badge good">在线 · 同步</span>`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function fmtRemaining(ms) {
  if (ms <= 0) return '已到期';
  const day = Math.floor(ms / 86_400_000);
  const hour = Math.floor((ms % 86_400_000) / 3_600_000);
  const min = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  if (day > 0) return `${day}天 ${hour}小时`;
  if (hour > 0) return `${hour}小时 ${min}分`;
  if (min > 0) return `${min}分 ${sec}秒`;
  return `${sec}秒`;
}

function deadlineAttrs(deadline) {
  const remaining = deadline - Date.now();
  return {
    cls: remaining <= 0 ? 'countdown expired' : 'countdown',
    text: remaining <= 0 ? '已到期（旧生产者被阻断）' : `剩 ${fmtRemaining(remaining)}`
  };
}

/* ---------- 数据加载 ---------- */

async function loadHealth() {
  const health = await api('/api/health');
  $('#recovery-meta').textContent =
    `WAL 序号 ${health.recovery.walSeq} · 重放事件 ${health.recovery.replayed} 条` +
    (health.recovery.recoveredPartial ? ' · 已修复半写日志' : '');
}

async function loadSubjects(keepSelection = true) {
  const data = await api('/api/subjects');
  subjects = data.subjects;
  const select = $('#subject-select');
  const prev = keepSelection ? select.value : null;
  select.innerHTML = subjects.length
    ? subjects.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}（v${s.currentVersion ?? '—'}）</option>`).join('')
    : '<option value="">（暂无主题）</option>';
  if (prev && subjects.some((s) => s.name === prev)) select.value = prev;
  currentSubject = select.value || null;
  if (currentSubject) await renderSubject(currentSubject);
  else $('#subject-view').innerHTML = `<div class="card empty">还没有主题，请在上方创建第一个主题并发布初始模式。</div>`;
}

async function renderSubject(name) {
  const s = await api(`/api/subjects/${encodeURIComponent(name)}`);
  const root = $('#subject-view');
  root.innerHTML = `
    ${renderTiles(s)}
    <div class="grid section-grid" style="margin-top:16px">
      <div class="card">${renderTimeline(s)}</div>
      <div class="card">${renderActors(s)}</div>
    </div>
    <div class="grid two-col" style="margin-top:16px">
      <div class="card">${renderPublishForm(s)}</div>
      <div class="card">${renderOpsForms(s)}</div>
    </div>
    <div class="grid two-col" style="margin-top:16px">
      <div class="card">${renderRecords(s)}</div>
      <div class="card">${renderAudit(s)}</div>
    </div>
  `;
  bindSubjectEvents(s);
}

/* ---------- 统计瓦片 ---------- */

function renderTiles(s) {
  const latest = s.versions.at(-1);
  const activeConsumers = s.actors.filter((a) => a.active && a.role === 'consumer').length;
  const activeProducers = s.actors.filter((a) => a.active && a.role === 'producer').length;
  const blocked = s.actors.filter((a) => a.blockedNow).length;
  const dl = latest
    ? deadlineAttrs(latest.windowDeadline)
    : { cls: 'countdown', text: '—' };
  return `
    <div class="grid tiles">
      <div class="card tile">
        <div class="label">当前版本</div>
        <div class="value">v${s.currentVersion ?? '—'}</div>
        <div class="sub">共 ${s.versions.length} 个版本 · 默认 ${esc(s.compatibilityMode)}</div>
      </div>
      <div class="card tile">
        <div class="label">兼容窗口截止</div>
        <div class="value ${dl.cls}" data-deadline="${latest?.windowDeadline ?? ''}">${dl.text}</div>
        <div class="sub">${latest ? fmtTime(latest.windowDeadline) : ''}</div>
      </div>
      <div class="card tile">
        <div class="label">活跃消费者</div>
        <div class="value">${activeConsumers}</div>
        <div class="sub">按各自策略独立判定</div>
      </div>
      <div class="card tile">
        <div class="label">活跃生产者</div>
        <div class="value">${activeProducers}</div>
        <div class="sub">${blocked > 0 ? `${blocked} 个已被窗口阻断` : '窗口内允许旧版写入'}</div>
      </div>
      <div class="card tile">
        <div class="label">存量记录</div>
        <div class="value">${s.recordCount}</div>
        <div class="sub">${s.migration ? `迁移：${s.migration.irreversible ? '不可逆' : '可逆'}` : '暂无迁移计划'}</div>
      </div>
    </div>
  `;
}

/* ---------- 版本时间线与兼容结果 ---------- */

function renderTimeline(s) {
  if (!s.versions.length) return `<h3>版本时间线</h3><div class="empty">尚未发布任何版本</div>`;
  const items = [...s.versions].reverse().map((v) => {
    const dl = deadlineAttrs(v.windowDeadline);
    const check = v.check;
    const checkHtml = check
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
           ${compatBadge(check.backward.compatible, 'BACKWARD')}
           ${compatBadge(check.forward.compatible, 'FORWARD')}
           ${compatBadge(check.full.compatible, 'FULL')}
           ${check.gateBypassed ? `<span class="badge serious">回滚 · 绕过闸门</span>` : ''}
         </div>
         ${renderViolations(check)}
         ${renderDataImpact(check)}`
      : `<div class="small" style="margin-top:8px">初始版本，无兼容性基线</div>`;
    const fields = v.schema.fields
      .map(
        (f) =>
          `<span class="chip ${v.retainedFields?.includes(f.name) ? 'retained' : ''}" title="${
            f.required ? '必填' : '可选'
          }${f.default !== undefined ? ` · 默认 ${esc(JSON.stringify(f.default))}` : ''}">${esc(f.name)}:${esc(f.type)}${
            f.required ? '' : '?'
          }</span>`
      )
      .join('');
    return `
      <li class="${v.kind === 'rollback' ? 'rollback' : ''}">
        <div class="v-head">
          <span class="v-title">v${v.version}</span>
          <span class="badge ${v.kind === 'rollback' ? 'serious' : 'accent'}">${
      v.kind === 'rollback' ? `回滚自 v${v.rollbackOf}` : '演进发布'
    }</span>
          <span class="badge neutral">${esc(v.publishedBy)}</span>
          <span class="${dl.cls}" data-deadline="${v.windowDeadline}">${dl.text}</span>
        </div>
        <div class="small" style="margin-top:4px">
          发布于 ${fmtTime(v.createdAt)} · 截止 ${fmtTime(v.windowDeadline)}
          ${v.retainedFields?.length ? `· 保留字段 ${esc(v.retainedFields.join(', '))}` : ''}
        </div>
        <div class="schema-fields">${fields}</div>
        ${checkHtml}
      </li>`;
  }).join('');
  return `<h3>版本与兼容结果</h3><ul class="timeline">${items}</ul>`;
}

function renderViolations(check) {
  const all = [
    ...check.backward.violations.map((x) => ({ ...x, dir: 'BACKWARD' })),
    ...check.forward.violations.map((x) => ({ ...x, dir: 'FORWARD' }))
  ];
  if (!all.length) return '';
  const uniq = new Map();
  for (const v of all) {
    const key = `${v.dir}:${v.code}:${v.field}:${v.symbol ?? ''}`;
    if (!uniq.has(key)) uniq.set(key, v);
  }
  return `<div style="margin-top:8px">${[...uniq.values()]
    .map(
      (v) =>
        `<div class="small">▸ <span class="badge ${v.dir === 'BACKWARD' ? 'warn' : 'serious'}">${esc(v.dir)}</span> ${esc(
          v.message
        )}</div>`
    )
    .join('')}</div>`;
}

function renderDataImpact(check) {
  if (!check.dataViolations) return '';
  const impacting = check.dataViolations.filter((v) => v.dataImpacting);
  if (!impacting.length) return `<div class="small" style="margin-top:6px">存量数据闸门：无真实受影响记录</div>`;
  return `<div style="margin-top:6px">
    <div class="small" style="font-weight:650">存量数据闸门：${impacting.length} 项命中历史记录</div>
    ${impacting
      .map(
        (v) =>
          `<div class="small">▸ ${esc(v.field)}${v.symbol ? `=${esc(v.symbol)}` : ''} · 影响 ${
            v.affectedRecordIds.length
          } 条记录 · key <span class="mono">${esc(v.migrationKey)}</span></div>`
      )
      .join('')}
  </div>`;
}

/* ---------- 参与者表格 ---------- */

function renderActors(s) {
  if (!s.actors.length) return `<h3>生产者 / 消费者</h3><div class="empty">暂无注册参与者</div>`;
  const rows = s.actors
    .map(
      (a) => `
      <tr>
        <td class="mono">${esc(a.name)}</td>
        <td><span class="badge neutral">${a.role === 'producer' ? '生产者' : '消费者'}</span></td>
        <td><span class="badge accent">${esc(a.mode)}</span></td>
        <td class="mono">v${a.schemaVersion}</td>
        <td>${stateBadge(a)}</td>
        <td class="small">${fmtTime(a.lastHeartbeat)}</td>
        <td class="row-actions">
          <button class="secondary" data-act="heartbeat" data-actor="${esc(a.name)}">心跳</button>
          <button class="danger" data-act="deregister" data-actor="${esc(a.name)}">注销</button>
        </td>
      </tr>`
    )
    .join('');
  return `<h3>生产者 / 消费者（独立兼容策略）</h3>
    <table>
      <thead><tr><th>名称</th><th>角色</th><th>策略</th><th>注册版本</th><th>状态</th><th>最近心跳</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ---------- 发布 / 注册 / 写入表单 ---------- */

function renderPublishForm(s) {
  const example = JSON.stringify(
    {
      name: s.versions.at(-1)?.schema.name ?? 'ExampleEvent',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'amount', type: 'long', required: false, default: 0 }
      ]
    },
    null,
    2
  );
  return `
    <h3>发布新版本</h3>
    <form class="stack" id="publish-form">
      <label class="field">新模式（JSON）<textarea name="schema">${esc(example)}</textarea></label>
      <label class="field">兼容窗口（毫秒，默认 7 天）
        <input name="window" type="number" value="${7 * 24 * 3600 * 1000}" min="1000" />
      </label>
      <label class="field">迁移计划（可选；存量数据受破坏时必填）
        <textarea name="migration" placeholder='{"steps":[{"key":"FIELD_BECAME_REQUIRED:amount","description":"回填 0"}]}'></textarea>
      </label>
      <button type="submit">发布并执行三闸门检查</button>
    </form>
    <hr style="border:none;border-top:1px solid var(--grid);margin:16px 0" />
    <h3>注册生产者 / 消费者</h3>
    <form class="stack" id="actor-form">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">名称 <input name="name" placeholder="billing-consumer" required /></label>
        <label class="field">角色
          <select name="role"><option value="producer">生产者 producer</option><option value="consumer">消费者 consumer</option></select>
        </label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">兼容策略
          <select name="mode">
            <option value="BACKWARD">BACKWARD 向后</option>
            <option value="FORWARD">FORWARD 向前</option>
            <option value="FULL">FULL 全兼容</option>
            <option value="NONE">NONE 不限制</option>
          </select>
        </label>
        <label class="field">注册模式版本
          <input name="version" type="number" min="1" value="${s.currentVersion ?? 1}" />
        </label>
      </div>
      <button type="submit">注册</button>
    </form>
    <hr style="border:none;border-top:1px solid var(--grid);margin:16px 0" />
    <h3>生产者写入（验证窗口阻断）</h3>
    <form class="stack" id="produce-form">
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px">
        <label class="field">生产者 <input name="actor" placeholder="producer-1" required /></label>
        <label class="field">记录 JSON <input name="payload" placeholder='{"id":"r-1"}' required /></label>
      </div>
      <button type="submit">写入</button>
    </form>`;
}

function renderOpsForms(s) {
  const versionOptions = s.versions
    .map((v) => `<option value="${v.version}">v${v.version}${v.kind === 'rollback' ? '（回滚版）' : ''}</option>`)
    .join('');
  return `
    <h3>运维操作</h3>
    <form class="stack" id="rollback-form">
      <label class="field">回滚目标版本
        <select name="target">${versionOptions || '<option>无可用版本</option>'}</select>
      </label>
      <button type="submit" class="danger">回滚（新字段自动保留为透传字段）</button>
    </form>
    <hr style="border:none;border-top:1px solid var(--grid);margin:16px 0" />
    <form class="stack" id="window-form">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">版本 <select name="version">${versionOptions}</select></label>
        <label class="field">延长毫秒 <input name="extra" type="number" value="86400000" min="1" /></label>
      </div>
      <button type="submit" class="secondary">延长兼容窗口</button>
    </form>
    <hr style="border:none;border-top:1px solid var(--grid);margin:16px 0" />
    <form class="stack" id="migration-form">
      <label class="field">登记迁移执行（步骤 key 列表，逗号分隔）
        <input name="keys" placeholder="FIELD_BECAME_REQUIRED:amount" />
      </label>
      <label class="field" style="grid-template-columns:auto auto;justify-content:start;align-items:center">
        <input type="checkbox" name="irreversible" style="width:auto" /> 标记为不可逆迁移（之后禁止回滚）
      </label>
      <button type="submit" class="secondary">登记迁移结果</button>
    </form>
    <hr style="border:none;border-top:1px solid var(--grid);margin:16px 0" />
    <form class="stack" id="ingest-form">
      <label class="field">运维直接写入（按最新版本校验）
        <input name="payload" placeholder='{"id":"seed-1"}' required />
      </label>
      <button type="submit" class="secondary">写入存量记录</button>
    </form>`;
}

/* ---------- 记录与审计 ---------- */

function renderRecords(s) {
  const records = [...(s.records ?? [])].reverse();
  if (!records.length) return `<h3>存量数据</h3><div class="empty">暂无记录</div>`;
  const rows = records
    .map(
      (r) => `
      <tr>
        <td class="mono">#${r.id}</td>
        <td class="mono">v${r.schemaVersion}</td>
        <td class="mono">${esc(r.writtenBy)}</td>
        <td class="small">${fmtTime(r.writtenAt)}</td>
        <td class="mono">${esc(JSON.stringify(r.payload))}</td>
      </tr>`
    )
    .join('');
  return `<h3>存量数据（${records.length}）</h3>
    <table><thead><tr><th>ID</th><th>写入版本</th><th>生产者</th><th>时间</th><th>内容</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderAudit(s) {
  if (!s.audit?.length) return `<h3>事件审计（最近 20 条）</h3><div class="empty">暂无事件</div>`;
  const rows = s.audit
    .map(
      (e) => `
      <tr>
        <td class="mono">#${e.seq}</td>
        <td><span class="badge neutral">${esc(e.type)}</span></td>
        <td class="small">${fmtTime(new Date(e.at).getTime())}</td>
      </tr>`
    )
    .join('');
  return `<h3>事件审计（最近 20 条）</h3>
    <table><thead><tr><th>序号</th><th>事件</th><th>时间</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/* ---------- 事件绑定 ---------- */

function bindSubjectEvents(s) {
  $('#publish-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const schema = JSON.parse(f.schema.value);
      const migrationRaw = f.migration.value.trim();
      const result = await api(`/api/subjects/${encodeURIComponent(s.name)}/versions`, {
        method: 'POST',
        body: {
          schema,
          compatibilityWindowMs: Number(f.window.value),
          migrationPlan: migrationRaw ? JSON.parse(migrationRaw) : null
        }
      });
      toast(`发布成功：v${result.version.version}`, formatCheckSummary(result.check));
      await loadSubjects();
    } catch (err) {
      toast('发布失败', err.payload ?? err.message, 'error');
    }
  });

  $('#actor-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const actor = await api(`/api/subjects/${encodeURIComponent(s.name)}/actors`, {
        method: 'POST',
        body: {
          name: f.name.value.trim(),
          role: f.role.value,
          mode: f.mode.value,
          schemaVersion: Number(f.version.value)
        }
      });
      toast(`已注册 ${actor.role}：${actor.name}`);
      await renderSubject(s.name);
    } catch (err) {
      toast('注册失败', err.payload ?? err.message, 'error');
    }
  });

  $('#produce-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const payload = JSON.parse(f.payload.value);
      const record = await api(`/api/subjects/${encodeURIComponent(s.name)}/produce`, {
        method: 'POST',
        body: { actor: f.actor.value.trim(), payload }
      });
      toast(`写入成功，记录 #${record.id}`);
      await renderSubject(s.name);
    } catch (err) {
      toast('写入被拒绝', err.payload ?? err.message, 'error');
    }
  });

  $('#rollback-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const v = await api(`/api/subjects/${encodeURIComponent(s.name)}/rollback`, {
        method: 'POST',
        body: { targetVersion: Number(f.target.value) }
      });
      toast(`已回滚，生成 v${v.version}，保留字段：${v.retainedFields.join(', ') || '无'}`);
      await loadSubjects();
    } catch (err) {
      toast('回滚失败', err.payload ?? err.message, 'error');
    }
  });

  $('#window-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(
        `/api/subjects/${encodeURIComponent(s.name)}/windows/${Number(f.version.value)}/extend`,
        { method: 'POST', body: { extraMs: Number(f.extra.value) } }
      );
      toast(`窗口已延长至 ${fmtTime(r.windowDeadline)}`);
      await renderSubject(s.name);
    } catch (err) {
      toast('延长失败', err.payload ?? err.message, 'error');
    }
  });

  $('#migration-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const keys = f.keys.value.split(',').map((x) => x.trim()).filter(Boolean);
    try {
      await api(`/api/subjects/${encodeURIComponent(s.name)}/migrations`, {
        method: 'POST',
        body: {
          steps: keys.map((key) => ({ key, description: '通过控制台登记' })),
          irreversible: f.irreversible.checked
        }
      });
      toast('迁移结果已登记');
      await renderSubject(s.name);
    } catch (err) {
      toast('登记失败', err.payload ?? err.message, 'error');
    }
  });

  $('#ingest-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const payload = JSON.parse(f.payload.value);
      const r = await api(`/api/subjects/${encodeURIComponent(s.name)}/ingest`, {
        method: 'POST',
        body: { payload }
      });
      toast(`运维写入成功 #${r.id}`);
      await renderSubject(s.name);
    } catch (err) {
      toast('写入失败', err.payload ?? err.message, 'error');
    }
  });

  document.querySelectorAll('[data-act="heartbeat"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api(
          `/api/subjects/${encodeURIComponent(s.name)}/actors/${encodeURIComponent(btn.dataset.actor)}/heartbeat`,
          { method: 'POST' }
        );
        await renderSubject(s.name);
      } catch (err) {
        toast('心跳失败', err.payload ?? err.message, 'error');
      }
    })
  );

  document.querySelectorAll('[data-act="deregister"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api(
          `/api/subjects/${encodeURIComponent(s.name)}/actors/${encodeURIComponent(btn.dataset.actor)}`,
          { method: 'DELETE' }
        );
        toast(`已注销 ${btn.dataset.actor}`);
        await renderSubject(s.name);
      } catch (err) {
        toast('注销失败', err.payload ?? err.message, 'error');
      }
    })
  );
}

function formatCheckSummary(check) {
  if (!check) return '初始版本';
  return [
    `BACKWARD ${check.backward.compatible ? '✓' : '✗'}`,
    `FORWARD ${check.forward.compatible ? '✓' : '✗'}`,
    `FULL ${check.full.compatible ? '✓' : '✗'}`,
    `消费者 ${check.consumerResults.every((c) => c.compatible) ? '全部兼容' : '存在阻断'}`
  ].join('\n');
}

/* ---------- 全局事件 ---------- */

$('#create-subject-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const subject = await api('/api/subjects', {
      method: 'POST',
      body: { name: f.name.value.trim(), compatibilityMode: f.mode.value }
    });
    toast(`主题已创建：${subject.name}`);
    f.reset();
    await loadSubjects(false);
    $('#subject-select').value = subject.name;
    currentSubject = subject.name;
    await renderSubject(subject.name);
  } catch (err) {
    toast('创建失败', err.payload ?? err.message, 'error');
  }
});

$('#subject-select').addEventListener('change', async (e) => {
  currentSubject = e.target.value || null;
  if (currentSubject) await renderSubject(currentSubject);
});

$('#btn-refresh').addEventListener('click', () => loadSubjects());

$('#btn-theme').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
});

$('#refresh-interval').addEventListener('change', (e) => {
  clearInterval(refreshTimer);
  const ms = Number(e.target.value);
  if (ms > 0) refreshTimer = setInterval(() => loadSubjects(), ms);
});

/* 倒计时每秒刷新（不重新请求接口） */
function tickCountdowns() {
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const deadline = Number(el.dataset.deadline);
    if (!deadline) return;
    const remaining = deadline - Date.now();
    el.textContent =
      remaining <= 0 ? '已到期（旧生产者被阻断）' : `剩 ${fmtRemaining(remaining)}`;
    el.classList.toggle('expired', remaining <= 0);
  });
}

async function bootstrap() {
  try {
    await loadHealth();
    await loadSubjects(false);
    refreshTimer = setInterval(() => loadSubjects(), 10_000);
    countdownTimer = setInterval(tickCountdowns, 1000);
    tickCountdowns();
  } catch (err) {
    toast('初始化失败', err.message, 'error');
  }
}

bootstrap();
