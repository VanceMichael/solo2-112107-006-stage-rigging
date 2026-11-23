const $ = (selector) => document.querySelector(selector);

const state = {
  venues: [],
  overview: null,
  analysis: null,
  pack: null,
};

const STATUS_CLASS = {
  signed: 'ok',
  conditional: 'warn',
  submitted: 'info',
  ready: 'info',
  resign: 'warn',
  missing: 'bad',
  conflict: 'bad',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, bad = false) {
  const node = el('div', { class: 'toast' + (bad ? ' bad' : ''), text: message });
  document.body.append(node);
  setTimeout(() => node.remove(), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  let body = null;
  try { body = await response.json(); } catch { /* empty */ }
  if (!response.ok) {
    throw new Error(body?.message ?? `请求失败（${response.status}）`);
  }
  return body;
}

function selectedVenue() {
  return state.venues.find((venue) => venue.id === $('#venue').value) ?? null;
}

function fillSelect(select, rows, { value, label, keep = false } = {}) {
  const previous = keep ? select.value : null;
  select.replaceChildren(...rows.map((row) => el('option', { value: value(row), text: label(row) })));
  if (previous && rows.some((row) => value(row) === previous)) select.value = previous;
}

async function loadVenues() {
  state.venues = await api('/api/venues');
  fillSelect($('#venue'), state.venues, { value: (v) => v.id, label: (v) => `${v.name}（${v.id}）· ${v.station}` });
  await loadOverview();
}

async function loadOverview() {
  const venue = selectedVenue();
  if (!venue) return;
  state.overview = null;
  $('#overview').replaceChildren(el('p', { text: '正在读取场馆发布…' }));
  try {
    state.overview = await api(`/api/venues/${venue.id}/overview`);
  } catch (error) {
    $('#overview').replaceChildren(el('p', { text: error.message }));
    return;
  }
  const phases = state.overview.phases.filter((phase) => !phase.error);
  fillSelect($('#phase'), phases, { value: (p) => p.phase, label: (p) => `${p.phase}（版次 ${p.revision ?? '—'}）` });
  renderOverview();
  await loadPlans();
}

function renderOverview() {
  const overview = state.overview;
  if (!overview) return;
  const nodes = [];
  for (const phase of overview.phases) {
    if (phase.error) {
      nodes.push(el('div', { class: 'row' }, el('span', { text: phase.phase }), el('span', { class: 'tag', text: phase.error })));
      continue;
    }
    const issues = phase.inspectionIssues?.length
      ? phase.inspectionIssues.map((issue) => `${issue.resource}：${issue.message}`).join('；')
      : '检测页已收齐';
    nodes.push(el('div', { class: 'row' },
      el('span', { text: `${phase.phase} · 版次 ${phase.revision ?? '—'}` }),
      el('span', { class: 'tag', text: `${phase.plans.length} 份清单` }),
    ));
    nodes.push(el('div', { class: 'row' }, el('span', { text: `清场条件区：${(phase.conditionalClearingZones ?? []).join('、') || '无'}` })));
    nodes.push(el('div', { class: 'row' }, el('span', { class: issues.length > 2 ? 'tag' : '', text: issues })));
  }
  if (overview.previous?.length) {
    nodes.push(el('h4', { text: '上一站交接' }));
    for (const previous of overview.previous) {
      const packs = previous.packs ?? [];
      nodes.push(el('div', { class: 'row' },
        el('span', { text: `${previous.station} · ${previous.name}` }),
        el('span', { class: 'tag', text: packs.length ? `${packs.length} 份装台包` : '暂无记录' }),
      ));
    }
  }
  nodes.push(el('h4', { text: '数据来源' }));
  nodes.push(el('p', { text: 'GET 巡视表 / 设备证书 / 吊点 / 分区；缺失页会逐项列出。' }));
  $('#overview').replaceChildren(...nodes);
}

async function loadPlans() {
  const phase = state.overview?.phases.find((row) => row.phase === $('#phase').value);
  if (!phase) return;
  const plans = phase.plans;
  const previousCall = $('#call').value;
  const calls = [...new Map(plans.map((plan) => [plan.call, plan])).values()];
  fillSelect($('#call'), calls, {
    value: (plan) => plan.call,
    label: (plan) => `${plan.call} · ${modeLabel(plan.mode)} · ${plan.opens}`,
    keep: true,
  });
  const call = $('#call').value || previousCall;
  const proposals = plans.filter((plan) => plan.call === call);
  fillSelect($('#proposal'), proposals, { value: (plan) => plan.proposal, label: (plan) => `${plan.proposal}（${plan.items} 件 · ${plan.kg} kg · ${plan.zones.join('/')}）` });
  $('#pickHint').textContent = proposals.length
    ? `本场 ${call} 有 ${proposals.length} 份清单；清单只列剧团申报物件，实际留存另见分区。`
    : '本场没有布景清单。';
}

function modeLabel(mode) {
  return mode === 'rehearsal' ? '彩排' : mode === 'performance' ? '演出' : (mode ?? '—');
}

async function analyse() {
  const venue = selectedVenue();
  if (!venue) return;
  const params = new URLSearchParams({
    phase: $('#phase').value,
    call: $('#call').value,
    proposal: $('#proposal').value,
  });
  try {
    const result = await api(`/api/venues/${venue.id}/analysis?${params}`);
    state.analysis = result;
    render(result);
  } catch (error) {
    toast(error.message, true);
  }
}

function render(result) {
  const root = $('#result');
  root.replaceChildren();
  if (result.error) {
    root.append(el('div', { class: 'empty' }, el('h2', { text: '无法分析' }), el('p', { text: result.error })));
    return;
  }
  root.append(renderSummary(result));
  for (const zone of result.zones) root.append(renderZone(result, zone));
  if (result.reminders.length) root.append(renderReminders(result.reminders));
  if (result.previousPacks?.length) root.append(renderPreviousPacks(result.previousPacks));
  root.append(renderSources(result));
}

function renderSummary(result) {
  const counts = result.counts;
  const overallClass = STATUS_CLASS[counts.conflict || counts.missing ? 'missing' : counts.signed ? 'signed' : 'ready'];
  return el('section', { class: 'summary' },
    el('div', { class: 'summary-top' },
      el('div', null,
        el('h2', { text: `${result.venue.name} · ${result.callId} · 清单 ${result.proposal}` }),
        el('p', { class: 'meta', text: `${modeLabel(result.mode)} · ${result.call.opens} · 资料 ${result.phase} 版次 ${result.revision ?? '—'} · 场次日期 ${result.day}` }),
      ),
      el('span', { class: `overall ${overallClass}`, text: result.overall }),
    ),
    el('div', { class: 'counts' },
      ...Object.entries(counts).filter(([, value]) => value).map(([key, value]) => el('span', { class: 'count' }, `${countLabel(key)} `, el('b', { text: value }))),
      result.handoverHeld ? el('span', { class: 'count' }, '交接挂起 ', el('b', { text: result.handoverHeld })) : null,
    ),
    el('p', { class: 'meta', text: result.basisNote }),
    result.inspectionIssues?.length
      ? el('div', { class: 'note warn' }, '检测页未收齐：', result.inspectionIssues.map((issue) => `${issue.resource}（${issue.message}）`).join('；'), el('small', { text: '缺失页面的证书不会被视为可用；该页相关物件会显示所缺材料。' }))
      : null,
  );
}

function countLabel(key) {
  return { signed: '已签字', submitted: '待回执', conditional: '待清场', ready: '可交签', resign: '待重签', missing: '缺资料', conflict: '冲突' }[key] ?? key;
}

function renderZone(result, zone) {
  const head = el('header', { class: 'zone-head' },
    el('div', null,
      el('h3', { class: 'zone-title', text: `承重区 ${zone.zone}` }),
      el('p', { class: 'zone-meta', text: `${modeLabel(zone.mode)} · 并用限额 ${zone.limitKg ?? '未发布'} kg · 申报 ${zone.totalDeclaredKg} kg${zone.retainedKg ? ` · 现场留存 ${zone.retainedKg} kg · 实际合计 ${zone.totalActualKg} kg` : ''}` }),
    ),
    el('span', { class: `badge ${zone.status}`, text: zone.statusLabel }),
  );

  const body = el('div', { class: 'zone-body' });

  body.append(el('div', { class: 'band' },
    el('h4', { text: '本区实际申报物件' }),
    el('table', null,
      el('thead', null, el('tr', null,
        el('th', { text: '物件编号' }), el('th', { text: '吊点 / 梁' }), el('th', { text: '编组' }),
        el('th', { class: 'num', text: '申报 kg' }), el('th', { text: '检测关联' }),
      )),
      el('tbody', null, ...zone.declared.map((item) => el('tr', null,
        el('td', { text: item.item }),
        el('td', { class: 'mono', text: `${item.point} / ${item.beam}` }),
        el('td', { text: item.group ?? '未注明' }),
        el('td', { class: 'num', text: item.kg }),
        el('td', null, ...(item.inspection.ids.length
          ? [el('span', { class: 'chip good', text: item.inspection.ids.join('、') }), el('span', { class: 'chip', text: item.inspection.link === 'inheritance' ? '沿用' : '直接登记' })]
          : [el('span', { class: 'chip bad', text: '缺关联检测' })])),
      ))),
    ),
    zone.retainedExtra.length
      ? el('p', { class: 'meta' }, '现场留存未纳入清单：', el('span', { text: zone.retainedExtra.map((row) => `${row.item} ${row.kg} kg（${row.cleared === 'pending' ? '待场馆确认卸下' : row.cleared}）`).join('、') }))
      : null,
    zone.groups.length > 1
      ? el('p', { class: 'meta', text: `编组：${zone.groups.map((group) => `${group.group} ${group.kg} kg`).join(' · ')}（同工况合计对照限额）` })
      : null,
  ));

  const notes = [];
  for (const conflict of zone.conflicts) {
    notes.push(el('div', { class: `note ${conflict.blocking === false ? 'warn' : 'danger'}` },
      conflict.message,
      el('small', { text: conflict.blocking === false ? '留待修改；不阻止送签，但交接与人工复核需处理。' : '阻断送签，须修改后交人工复核。' }),
    ));
  }
  for (const miss of zone.missing) {
    notes.push(el('div', { class: 'note danger' },
      `缺少可关联检测：${miss.item}（${miss.point} / 梁 ${miss.beam}）`,
      el('ul', null, ...(miss.reasons ?? []).map((reason) => el('li', { text: reason })),
        ...(miss.inheritanceRejected ?? []).map((row) => el('li', { text: `沿用 ${row.certificate}（${row.old_beam} → ${miss.beam}）被拒：${row.reasons.join('、')}` })),
        ...(miss.wrongModeCertificates ?? []).map((row) => el('li', { text: `${row.certificate} 只覆盖 ${(row.modes ?? []).map(modeLabel).join('、')}，不适用本工况` })),
      ),
      el('small', { text: '须向场馆补取该梁在本工况的证书或明示沿用；其它分区资料齐全可继续交签。' }),
    ));
  }
  if (zone.signature.advisory?.length) {
    for (const line of zone.signature.advisory) notes.push(el('div', { class: 'note info' }, line));
  }
  if (notes.length) body.append(el('div', { class: 'notes' }, ...notes));

  const signatureBox = el('div', { class: 'split' },
    el('div', { class: 'band' },
      el('h4', { text: '签字与送签状态' }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: '来源/门户签字' }), el('b', { text: zone.signature.receipt ?? '无' })),
        el('div', null, el('span', { text: '签字状态' }), el('b', { text: signatureState(zone.signature) })),
        el('div', null, el('span', { text: '最近送签' }), el('b', { text: zone.latestSubmission?.receipt ?? '无' })),
        el('div', null, el('span', { text: '送签状态' }), el('b', { text: submissionState(zone.latestSubmissionState) })),
      ),
      zone.signature.reasons?.length
        ? el('div', { class: 'note warn' }, '须重新确认：', el('ul', null, ...zone.signature.reasons.map((reason) => el('li', { text: reason }))),
          el('small', { text: '同区同编组物件须一并重新确认，不能只重签变化的那一件。' }))
        : null,
    ),
    el('div', { class: 'band' },
      el('h4', { text: '现场交接' }),
      el('p', { text: zone.handover.status === 'ready' ? '可交接：本区签字覆盖当前工况与资料。' : '交接挂起' }),
      zone.handover.reasons.length
        ? el('ul', { class: 'meta' }, ...zone.handover.reasons.map((reason) => el('li', { text: reason })))
        : null,
      el('p', { class: 'meta', text: zone.submitScope === 'after-clearing'
        ? '本区属清空后启用的分区：送签或补件可继续，现场交接须待场馆确认清空。'
        : '按当前申报送签。' }),
    ),
  );
  body.append(signatureBox);

  return el('article', { class: 'zone' }, head, body);
}

function signatureState(signature) {
  if (!signature || signature.status === 'none') return '未签';
  if (signature.status === 'signed') return signature.source === 'portal' ? '已签字（门户回执）' : '已签字（来源）';
  if (signature.status === 'resign') return '待重签';
  return signature.status;
}

function submissionState(value) {
  return { none: '未送签', pending: '待回执', signed: '已回执' }[value] ?? value;
}

function renderReminders(reminders) {
  const map = { resign: 'warn', hold: 'warn', action: 'warn', info: 'info', danger: 'bad' };
  return el('section', { class: 'reminders' },
    el('h3', { text: `变更与留存提醒（${reminders.length}）` }),
    el('div', { class: 'notes' }, ...reminders.map((item) => el('div', { class: `note ${map[item.severity] ?? 'info'}` },
      el('strong', { text: `${item.zone} · ${reminderKind(item.kind)}` }),
      el('div', { text: item.message }),
      el('small', { text: item.requires }),
    ))),
  );
}

function reminderKind(kind) {
  return {
    'mounted-uncleared': '现场未确认撤场',
    'signed-scope-changed': '签字范围已变化',
    'mode-switch': '彩排 ↔ 演出切换',
    'shared-zone-different-scope': '共用区其它物件',
    'signed-zone-absent': '旧签字分区不在本清单',
    'signed-zone-dropped': '已送签分区被换清单',
    'pack-zone-not-in-plan': '已建包装台分区不在本清单',
    'item-without-point': '物件无法定位承重区',
    'submission-stale': '旧送签已不适用',
  }[kind] ?? kind;
}

function renderPreviousPacks(packs) {
  return el('section', { class: 'reminders' },
    el('h3', { text: '上一站确认过的装台记录' }),
    el('table', null,
      el('thead', null, el('tr', null,
        el('th', { text: '装台包' }), el('th', { text: '站点' }), el('th', { text: '清单 / 场次' }),
        el('th', { text: '版次' }), el('th', { text: '已确认分区' }), el('th', { text: '状态' }),
      )),
      el('tbody', null, ...packs.map((pack) => el('tr', null,
        el('td', { class: 'mono', text: pack.id }),
        el('td', { text: `${pack.station} · ${pack.venueName}` }),
        el('td', { text: `${pack.proposal} / ${pack.call}` }),
        el('td', { text: pack.revision ?? '—' }),
        el('td', { text: (pack.confirmedZones ?? []).join('、') || '无' }),
        el('td', { text: pack.status === 'submitted' ? '已送签' : pack.status }),
      ))),
    ),
    el('p', { class: 'meta', text: '上一站记录仅供对照；本站吊点、限额、证书与签字互不通用，须按当地发布重新送签。' }),
  );
}

function renderSources(result) {
  return el('details', { class: 'sources' },
    el('summary', { text: `来源采集记录（${result.sourceCalls.filter((call) => call.ok).length}/${result.sourceCalls.length} 页）` }),
    el('div', { class: 'grid' }, ...result.sourceCalls.map((call) => el('div', { class: 'call' + (call.ok ? '' : ' bad') },
      el('span', { text: `${call.phase}/${call.resource}` }),
      el('span', { text: call.ok ? call.status : `${call.status} ${call.message ?? ''}` }),
    ))),
  );
}

async function buildPack() {
  const venue = selectedVenue();
  if (!venue) return;
  const call = $('#call').value;
  const proposal = $('#proposal').value;
  if (!call || !proposal) return toast('先选场次与清单', true);
  try {
    const pack = await api(`/api/venues/${venue.id}/packs`, {
      method: 'POST',
      body: JSON.stringify({ phase: $('#phase').value, call, proposal }),
    });
    state.pack = pack;
    renderPack(pack);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderPack(pack) {
  const body = $('#packBody');
  const nodes = [
    el('div', { class: 'pack-head' },
      el('h2', { text: `装台包 ${pack.id}` }),
      el('p', { class: 'meta', text: `${pack.venue.name} · ${pack.call} · ${modeLabel(pack.mode)} · 清单 ${pack.proposal} · 资料 ${pack.phase} 版次 ${pack.revision}` }),
      el('p', { class: 'meta', text: pack.basisNote }),
    ),
    el('div', { class: 'pack-actions' },
      el('button', { class: 'primary', onclick: () => submitPack(pack.id, null) }, '按全部分区送签'),
      el('button', { class: 'secondary', onclick: () => refreshPack(pack.id) }, '刷新当前状态'),
      el('button', { class: 'ghost', onclick: () => reviewPack(pack.id) }, '对照变更复核'),
    ),
  ];

  if (pack.overall) nodes.push(el('p', null, el('span', { class: 'overall info', text: pack.overall })));

  for (const zone of pack.zones) {
    const notes = [];
    for (const conflict of zone.conflicts ?? []) notes.push(el('div', { class: 'note danger' }, conflict.message));
    for (const miss of zone.missing ?? []) notes.push(el('div', { class: 'note danger' }, `缺可关联检测：${miss.item}（${miss.point}/${miss.beam}）；` + (miss.reasons ?? []).join('；')));
    for (const line of zone.signature?.advisory ?? []) notes.push(el('div', { class: 'note info' }, line));
    if (zone.signature?.reasons?.length) notes.push(el('div', { class: 'note warn' }, '须重新确认：', zone.signature.reasons.join('；')));

    nodes.push(el('article', { class: 'zone' },
      el('header', { class: 'zone-head' },
        el('div', null,
          el('h3', { class: 'zone-title', text: `${zone.zone} · ${zone.statusLabel}` }),
          el('p', { class: 'zone-meta', text: `限额 ${zone.limitKg ?? '未发布'} kg · 申报 ${zone.totalDeclaredKg} kg · 检测 ${zone.inspections.join('、') || '无'}` }),
        ),
        el('button', { class: 'small', disabled: !zone.submitAllowed, onclick: () => submitPack(pack.id, zone.zone) }, zone.submitAllowed ? '送签此区' : '不可送签'),
      ),
      el('div', { class: 'zone-body' },
        el('table', null,
          el('thead', null, el('tr', null, el('th', { text: '物件' }), el('th', { text: '吊点 / 梁' }), el('th', { text: '编组' }), el('th', { class: 'num', text: 'kg' }), el('th', { text: '证书' }))),
          el('tbody', null, ...zone.declared.map((item) => el('tr', null,
            el('td', { text: item.item }),
            el('td', { class: 'mono', text: `${item.point} / ${item.beam}` }),
            el('td', { text: item.group ?? '—' }),
            el('td', { class: 'num', text: item.kg }),
            el('td', { text: item.inspection.ids.join('、') || '缺' }),
          ))),
        ),
        zone.retained?.length ? el('p', { class: 'meta', text: '现场留存（未纳入清单）：' + zone.retained.map((row) => `${row.item} ${row.kg} kg`).join('、') }) : null,
        notes.length ? el('div', { class: 'notes' }, ...notes) : null,
        zone.handover?.status === 'held'
          ? el('p', { class: 'meta', text: '现场交接挂起：' + zone.handover.reasons.join('；') })
          : el('p', { class: 'meta', text: '现场交接：可放行' }),
        zone.submissions?.length
          ? el('p', { class: 'meta', text: '送签记录：' + zone.submissions.map((row) => `${row.receipt ?? row.key}（${submissionState(row.decision === 'signed' ? 'signed' : 'pending')}）`).join('、') })
          : null,
      ),
    ));
  }

  if (pack.reminders?.length) {
    nodes.push(el('div', { class: 'reminders' },
      el('h3', { text: '变更与留存提醒' }),
      el('div', { class: 'notes' }, ...pack.reminders.map((item) => el('div', { class: 'note warn' },
        el('strong', { text: `${item.zone} · ${reminderKind(item.kind)}` }),
        el('div', { text: item.message }),
        el('small', { text: item.requires }),
      ))),
    ));
  }

  nodes.push(el('p', { class: 'meta mono', text: `包指纹 ${pack.digest?.slice(0, 16) ?? '—'}…` }));
  if (pack.needsHumanReview) {
    nodes.splice(1, 0, el('div', { class: 'note warn' }, '本包装台包保留了冲突或变更待处理项，须交人工复核；场馆签字只覆盖其确认时适用的分区、工况与资料版次。'));
  }
  body.replaceChildren(...nodes);
  const dialog = $('#packDialog');
  if (!dialog.open) dialog.showModal();
}

async function refreshPack(packId) {
  const venue = selectedVenue();
  try {
    const pack = await api(`/api/venues/${venue.id}/packs/${packId}`);
    renderPack(pack);
  } catch (error) {
    toast(error.message, true);
  }
}

async function submitPack(packId, zone) {
  const venue = selectedVenue();
  try {
    const result = await api(`/api/venues/${venue.id}/submit`, { method: 'POST', body: JSON.stringify({ pack: packId, zone }) });
    for (const row of result.results) {
      if (!row.accepted) {
        toast(`${row.zone}：${row.message}${row.retryable ? '（可重试）' : ''}`, true);
        continue;
      }
      if (row.zone && row.key) {
        try {
          await api(`/api/venues/${venue.id}/inspect`, { method: 'POST', body: JSON.stringify({ key: row.key }) });
        } catch { /* receipt stays pending */ }
      }
    }
    toast(`已送签 ${result.accepted} 个分区，${result.rejected} 个未接收`);
    const pack = await api(`/api/venues/${venue.id}/packs/${packId}`);
    renderPack(pack);
    await analyse();
  } catch (error) {
    toast(error.message, true);
  }
}

async function reviewPack(packId) {
  const venue = selectedVenue();
  try {
    const review = await api(`/api/venues/${venue.id}/packs/${packId}/review`);
    const body = $('#packBody');
    body.prepend(el('section', { class: 'reminders' },
      el('h3', { text: `变更复核 · 对照版次 ${review.comparisonPhase}（当前 ${review.latestPhase}）` }),
      review.superseded ? el('div', { class: 'note warn' }, review.superseded) : null,
      el('div', { class: 'notes' },
        ...review.comparisons.map((row) => el('div', { class: `note ${row.state === 'unchanged' ? 'ok' : row.state === 'changed' ? 'warn' : 'info'}` },
          el('strong', { text: `${row.zone} · ${{ unchanged: '完全适用', changed: '须重签', 'new-in-plan': '新增分区' }[row.state] ?? row.state}` }),
          el('div', { text: row.message }),
          row.changes?.length ? el('ul', null, ...row.changes.map((change) => el('li', { text: change.message }))) : null,
        )),
        ...review.dropped.map((row) => el('div', { class: 'note warn' },
          el('strong', { text: `${row.zone} · ${row.state}` }),
          el('div', { text: row.message }),
        )),
      ),
    ));
  } catch (error) {
    toast(error.message, true);
  }
}

$('#venue').addEventListener('change', () => loadOverview());
$('#phase').addEventListener('change', () => { renderOverview(); loadPlans(); });
$('#call').addEventListener('change', () => loadPlans());
$('#analyse').addEventListener('click', analyse);
$('#buildPack').addEventListener('click', buildPack);

loadVenues().catch((error) => toast(error.message, true));
