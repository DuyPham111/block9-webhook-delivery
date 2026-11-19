const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const api = async (method, url, body) => {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

// --------------------------------------------------------------------------
// Tabs
// --------------------------------------------------------------------------
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === `tab-${b.dataset.tab}`);
});

// --------------------------------------------------------------------------
// Bảng
// --------------------------------------------------------------------------
const TAG = new Set(['status', 'outcome']);

function table(rows, cols) {
  if (!rows || rows.length === 0) return el('div', 'empty', 'chưa có dòng nào');
  const t = el('table');
  const hr = el('tr');
  for (const c of cols) hr.append(el('th', null, c.label ?? c.key));
  const th = el('thead');
  th.append(hr);
  t.append(th);
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    for (const c of cols) {
      const td = el('td', c.mono ? 'mono' : null);
      const v = c.get ? c.get(r) : r[c.key];
      if (TAG.has(c.key) && v) td.append(el('span', `tag ${v}`, v));
      else td.textContent = v === null || v === undefined ? '—' : String(v);
      tr.append(td);
    }
    tb.append(tr);
  }
  t.append(tb);
  return t;
}

const shortTime = (s) => (s ? new Date(s).toISOString().slice(11, 23) : null);
const sha = (s) => (s ? s.slice(0, 8) : null);

// --------------------------------------------------------------------------
// Trạng thái
// --------------------------------------------------------------------------
const SERVICES = ['sender-api', 'relay', 'receiver-api', 'receiver-worker'];
let lastState = null;

function renderProcs(procs) {
  const box = $('#procs');
  box.replaceChildren();
  for (const s of SERVICES) {
    const state = procs[s] ?? 'missing';
    const chip = el('span', 'proc-chip');
    chip.append(el('span', `dot ${state}`), el('b', null, s.replace('receiver-', 'rcv-')));
    for (const [label, action] of [['bật', 'start'], ['tắt', 'stop'], ['kill', 'kill']]) {
      const b = el('button', null, label);
      b.onclick = async () => {
        b.disabled = true;
        await api('POST', '/api/proc', { service: s, action });
        refresh();
      };
      chip.append(b);
    }
    box.append(chip);
  }
}

async function refresh() {
  const s = await api('GET', '/api/state');
  lastState = s;
  renderProcs(s.procs);
  if ($('#fault').value !== (s.fault ?? '')) $('#fault').value = s.fault ?? '';

  $('#t-jobs').replaceChildren(table(s.sender.jobs, [
    { key: 'job_id', label: 'job', mono: true }, { key: 'video_id', label: 'video' },
    { key: 'version' }, { key: 'status' },
  ]));
  $('#t-outbox').replaceChildren(table(s.sender.outbox, [
    { key: 'event_id', label: 'event', mono: true }, { key: 'status' },
    { key: 'round', label: 'vòng' }, { key: 'attempts_in_round', label: 'lượt đã dùng' },
    { key: 'sha', label: 'body sha', mono: true, get: (r) => sha(r.body_sha256) },
  ]));
  $('#t-attempts').replaceChildren(table(s.sender.attempts, [
    { key: 'attempt_id', label: 'attempt', mono: true }, { key: 'event_id', label: 'event', mono: true },
    { key: 'attempt_in_round', label: 'lần' }, { key: 'outcome' },
    { key: 'http_status', label: 'http' }, { key: 'error_kind', label: 'lỗi' },
    { key: 'started', label: 'bắt đầu', mono: true, get: (r) => shortTime(r.started_at) },
  ]));
  $('#t-replays').replaceChildren(table(s.sender.replays, [
    { key: 'event_id', label: 'event', mono: true }, { key: 'round', label: 'vòng mới' },
    { key: 'note', label: 'ghi chú' },
  ]));
  $('#t-inbox').replaceChildren(table(s.receiver.inbox, [
    { key: 'event_id', label: 'event', mono: true }, { key: 'version' }, { key: 'status' },
    { key: 'sha', label: 'body sha', mono: true, get: (r) => sha(r.body_sha256) },
    { key: 'processed', label: 'xử lý lúc', mono: true, get: (r) => shortTime(r.processed_at) },
  ]));
  $('#t-sum').replaceChildren(table(s.receiver.video_summaries, [
    { key: 'video_id', label: 'video', mono: true }, { key: 'version' },
    { key: 'applied_count', label: 'applied_count' },
    { key: 'source_event_id', label: 'từ event', mono: true },
  ]));

  const box = $('#t-api');
  box.replaceChildren();
  const v = s.receiver.video_summaries[0];
  if (!v) {
    box.append(el('div', 'empty', '404 — chưa có bản tóm tắt'));
  } else {
    box.append(el('div', null, `200 — version ${v.version}, applied_count ${v.applied_count}`));
    box.append(el('div', 'empty', v.summary));
  }
}

function msg(text, bad) {
  const m = $('#live-msg');
  m.className = bad ? 'msg err' : 'msg';
  m.textContent = text;
}

// --------------------------------------------------------------------------
// Chạy tay
// --------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-complete]');
  if (c) {
    const r = await api('POST', `/api/complete/${c.dataset.complete}`);
    msg(`POST /jobs/${c.dataset.complete}/complete → ${r.status} ${JSON.stringify(r.body)}`, r.status >= 400);
    refresh();
    return;
  }
  if (e.target.closest('[data-reset]')) {
    await api('POST', '/api/reset');
    msg('đã reset fixture');
    refresh();
    return;
  }
  const rp = e.target.closest('[data-replay]');
  if (rp) {
    const r = await api('POST', `/api/replay/${rp.dataset.replay}`, { note: 'từ UI demo' });
    msg(`POST /events/${rp.dataset.replay}/replay → ${r.status} ${JSON.stringify(r.body)}`, r.status >= 400);
    refresh();
  }
});

$('#fault').addEventListener('change', async (e) => {
  const r = await api('POST', '/api/fault', { fault: e.target.value || null });
  msg(`lỗi giả của receiver: ${r.body?.fault || 'không'}`);
});

// --------------------------------------------------------------------------
// Ma trận kịch bản
// --------------------------------------------------------------------------
let cases = [];
let busy = false;

async function loadCases() {
  cases = (await api('GET', '/api/cases')).cases;
  const list = $('#case-list');
  list.replaceChildren();
  for (const c of cases) {
    const row = el('div', 'case');
    row.append(el('span', 'id', c.id));
    const body = el('div', 'body');
    const t = el('div', 't');
    t.append(document.createTextNode(c.title));
    if (c.kill) t.append(el('span', 'kill', 'kill thật'));
    body.append(t, el('div', 'e', c.expected));
    const res = el('div', 'res');
    res.id = `res-${c.id}`;
    body.append(res);
    row.append(body);
    const b = el('button', 'primary', 'Chạy');
    b.onclick = () => runCase(c);
    row.append(b);
    list.append(row);
  }
}

function logLine(cls, text) {
  const log = $('#case-log');
  log.append(el('div', cls, text));
  log.scrollTop = log.scrollHeight;
}

function runCase(c) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll('#case-list button')) b.disabled = true;
  $('#case-title').textContent = `— ${c.id}: ${c.title}`;
  $('#case-log').replaceChildren();
  $('#case-checks').replaceChildren();
  $(`#res-${c.id}`).textContent = 'đang chạy…';
  $(`#res-${c.id}`).className = 'res';

  const es = new EventSource(`/api/case/${c.id}/stream`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'begin') logLine('step', `=== ${ev.id}: ${ev.title}`);
    if (ev.type === 'step') logLine('step', `· ${ev.msg}`);
    if (ev.type === 'note') logLine('note', `  ${ev.msg}`);
    if (ev.type === 'snapshot') {
      logLine('snap', `  [snapshot] ${ev.label}`);
      lastState = ev.snapshot;
      renderProcs(ev.snapshot.procs);
    }
    if (ev.type === 'check') {
      logLine(ev.ok ? 'ok' : 'bad', `${ev.ok ? 'PASS' : 'FAIL'} ${ev.name}`);
      const d = el('div', `check ${ev.ok ? 'ok' : 'bad'}`);
      d.append(el('span', 'k', ev.ok ? 'PASS' : 'FAIL'), el('span', null, ev.name));
      if (!ev.ok) {
        d.append(el('span', 'd', `mong đợi ${JSON.stringify(ev.expected)} · quan sát ${JSON.stringify(ev.observed)}`));
      }
      $('#case-checks').append(d);
    }
    if (ev.type === 'error') logLine('bad', `LỖI: ${ev.msg}`);
    if (ev.type === 'done') {
      const r = ev.result;
      const passed = r.checks.filter((x) => x.ok).length;
      logLine(r.ok ? 'ok' : 'bad', `${r.ok ? 'ĐẠT' : 'KHÔNG ĐẠT'} — ${passed}/${r.checks.length} kiểm tra, ${Math.round(r.ms / 1000)}s`);
      const res = $(`#res-${c.id}`);
      res.textContent = `${r.ok ? 'ĐẠT' : 'KHÔNG ĐẠT'} · ${passed}/${r.checks.length} kiểm tra · ${Math.round(r.ms / 1000)}s`;
      res.className = `res ${r.ok ? 'ok' : 'bad'}`;
      es.close();
      busy = false;
      for (const b of document.querySelectorAll('#case-list button')) b.disabled = false;
      refresh();
    }
  };
  es.onerror = () => {
    if (!busy) return;
    logLine('bad', 'mất kết nối tới server UI');
    es.close();
    busy = false;
    for (const b of document.querySelectorAll('#case-list button')) b.disabled = false;
  };
}

// --------------------------------------------------------------------------
loadCases();
refresh();
setInterval(() => {
  if (!busy) refresh();
}, 2000);
