import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { toIso } from '../src/reserve.js';
import {
  normalizeLimitInput,
  normalizeMaintenanceInput,
  summarizeUsage,
  quotaForDevice,
  runDurationMs,
} from '../src/maintenance.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

async function completeVerificationFor(pubId) {
  const created = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const vid = created.json.id;
  const pub = await call('GET', `/api/publications/${pubId}`);
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const saved = await call('PUT', `/api/verifications/${vid}`, { version: 1, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const done = await call('POST', `/api/verifications/${vid}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return vid;
}

let pub1;
let v1;
let batchSeq = 0;

async function makeWideReservation() {
  batchSeq += 1;
  const now = Date.now();
  const r = await call('POST', '/api/reservations', {
    batchNo: `RB-MAINT-${batchSeq}`,
    publicationId: pub1,
    startUtc: iso(now - 3600_000),
    endUtc: iso(now + 3600_000),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

// 开始运行（每次新建覆盖当前时刻的预约），返回运行视图
async function startRun(runNo, deviceNo, verificationId = v1) {
  const reservationId = await makeWideReservation();
  const r = await call('POST', '/api/runs', {
    runNo,
    deviceNo,
    verificationId,
    reservationId,
  });
  return r;
}

// 直接改写服务端记录的起止时间（额度只按服务端起止时间累计，与真实耗时无关）
function forceRunTimes(id, startMs, endMs, outcome = 'completed') {
  db.prepare('UPDATE runs SET start_utc = ?, ended_at = ?, outcome = ?, timed_out = 0 WHERE id = ?')
    .run(toIso(startMs), endMs == null ? null : toIso(endMs), endMs == null ? null : outcome, id);
}

async function deviceStatus(deviceNo) {
  const r = await call('GET', `/api/devices/${encodeURIComponent(deviceNo)}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

test('准备：发布图 + 已完成核验', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  pub1 = (await call('POST', '/api/publish')).json.id;
  v1 = await completeVerificationFor(pub1);
});

test('纯函数：上限/保养输入规整', () => {
  assert.deepEqual(normalizeLimitInput({ deviceNo: ' D1 ', limitSeconds: 10 }).clean, {
    deviceNo: 'D1',
    limitSeconds: 10,
  });
  for (const bad of [
    null,
    {},
    { deviceNo: ' ', limitSeconds: 10 },
    { deviceNo: 'D1', limitSeconds: 0 },
    { deviceNo: 'D1', limitSeconds: -3 },
    { deviceNo: 'D1', limitSeconds: 1.5 },
    { deviceNo: 'D1', limitSeconds: '10' },
    { deviceNo: 'D1', limitSeconds: true },
    { deviceNo: 'D1' },
  ]) {
    assert.ok(normalizeLimitInput(bad).errors.length > 0, JSON.stringify(bad));
  }
  assert.deepEqual(
    normalizeMaintenanceInput({ maintenanceNo: ' M-1 ', deviceNo: ' D ', reason: ' 例行保养 ' }).clean,
    { maintenanceNo: 'M-1', deviceNo: 'D', reason: '例行保养' },
  );
  for (const bad of [
    null,
    {},
    { maintenanceNo: 'M-1', deviceNo: 'D', reason: '  ' },
    { maintenanceNo: '', deviceNo: 'D', reason: 'r' },
    { maintenanceNo: 'M-1', deviceNo: '', reason: 'r' },
  ]) {
    assert.ok(normalizeMaintenanceInput(bad).errors.length > 0, JSON.stringify(bad));
  }
});

test('纯函数：已完结运行累计（完成/中止计入、进行中不计、按最近保养切周期）', () => {
  const t0 = 1_000_000;
  const run = (startSec, endSec) => ({
    startUtc: toIso(t0 + startSec * 1000),
    endedAt: endSec == null ? null : toIso(t0 + endSec * 1000),
  });
  const runs = [
    run(0, 6), // 完成
    run(6, 11), // 中止（测试时 outcome 不参与，只看起止）
    run(11, null), // 进行中
  ];
  assert.equal(runDurationMs(runs[0]), 6000);
  assert.equal(runDurationMs(runs[2]), null);

  // 无保养记录：计入全部已完结，进行中不计
  let s = summarizeUsage({ runs, sinceMs: null });
  assert.equal(s.usedMs, 11_000);
  assert.equal(s.countedRuns, 2);

  // 周期起点在第 2 条运行开始之后：仅计入之后的已完结（进行中仍不计）
  s = summarizeUsage({ runs, sinceMs: t0 + 7_000 });
  assert.equal(s.usedMs, 0);
  assert.equal(s.countedRuns, 0);

  // 周期起点恰等于某运行开始时刻（左闭）：该运行计入
  s = summarizeUsage({ runs, sinceMs: t0 + 6_000 });
  assert.equal(s.usedMs, 5_000);
  assert.equal(s.countedRuns, 1);

  // 额度：恰达到上限即待保养；剩余不转负
  const q = quotaForDevice({ runs, limitSeconds: 11, sinceMs: null });
  assert.equal(q.due, true);
  assert.equal(q.remainingSeconds, 0);
  assert.equal(q.overSeconds, 0);
  assert.equal(q.usedSeconds, 11);
  const q2 = quotaForDevice({ runs, limitSeconds: 10, sinceMs: null });
  assert.equal(q2.due, true);
  assert.equal(q2.overSeconds, 1);
  const q3 = quotaForDevice({ runs, limitSeconds: 12, sinceMs: null });
  assert.equal(q3.due, false);
  assert.equal(q3.remainingSeconds, 1);
});

test('设备状态初始为空；未知设备 404；/api/state 含设备/保养/上限列表', async () => {
  const devices = await call('GET', '/api/devices');
  assert.deepEqual(devices.json, []);
  const one = await call('GET', '/api/devices/NOPE');
  assert.equal(one.status, 404);
  const s = await call('GET', '/api/state');
  assert.ok(Array.isArray(s.json.devices));
  assert.ok(Array.isArray(s.json.maintenances));
  assert.ok(Array.isArray(s.json.deviceLimits));
});

test('上限设置：非法输入 400；首次 201、调整 200；GET 列表与设备状态', async () => {
  for (const bad of [
    {},
    { deviceNo: 'CENT-Q' },
    { deviceNo: 'CENT-Q', limitSeconds: 0 },
    { deviceNo: 'CENT-Q', limitSeconds: -1 },
    { deviceNo: 'CENT-Q', limitSeconds: 2.5 },
    { deviceNo: 'CENT-Q', limitSeconds: '10' },
    { deviceNo: '', limitSeconds: 10 },
  ]) {
    const r = await call('PUT', '/api/device-limits', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }

  let r = await call('PUT', '/api/device-limits', { deviceNo: 'CENT-Q', limitSeconds: 10 });
  assert.equal(r.status, 201);
  assert.equal(r.json.deviceNo, 'CENT-Q');
  assert.equal(r.json.limitSeconds, 10);

  r = await call('PUT', '/api/device-limits', { deviceNo: 'CENT-Q', limitSeconds: 8 });
  assert.equal(r.status, 200);
  assert.equal(r.json.limitSeconds, 8);

  const list = await call('GET', '/api/device-limits');
  assert.ok(list.json.some((x) => x.deviceNo === 'CENT-Q' && x.limitSeconds === 8));

  const d = await deviceStatus('CENT-Q');
  assert.equal(d.limitSeconds, 8);
  assert.equal(d.usedSeconds, 0);
  assert.equal(d.remainingSeconds, 8);
  assert.equal(d.due, false);
  assert.equal(d.running, false);
  assert.equal(d.lastMaintenance, null);
  assert.equal(d.countedRuns, 0);

  // 恢复为 10 秒以便后续用例
  r = await call('PUT', '/api/device-limits', { deviceNo: 'CENT-Q', limitSeconds: 10 });
  assert.equal(r.status, 200);
});

test('累计与待保养：完成与中止均计入、运行即使越上限也如实完结；达到上限后新运行 409 且不留记录', async () => {
  // 强制的历史时间戳放在「过去」，避免后续测试在真实 now 登记保养时把它们误入新周期
  const base = Date.now() - 60_000;

  // 第一条运行：6 秒（完成）
  let r = await startRun('RQ-1', 'CENT-Q');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id1 = r.json.id;
  forceRunTimes(id1, base, base + 6_000, 'completed');
  let d = await deviceStatus('CENT-Q');
  assert.equal(d.usedSeconds, 6);
  assert.equal(d.remainingSeconds, 4);
  assert.equal(d.due, false);
  assert.equal(d.countedRuns, 1);

  // 第二条运行：5 秒（中止）——越过上限也如实完结（完结接口不做额度核对）
  r = await startRun('RQ-2', 'CENT-Q');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id2 = r.json.id;
  // 完结：进行中不提前计入
  d = await deviceStatus('CENT-Q');
  assert.equal(d.usedSeconds, 6);
  assert.equal(d.running, true);
  assert.equal(d.activeRunId, id2);
  const done = await call('POST', `/api/runs/${id2}/complete`, { outcome: 'aborted' });
  assert.equal(done.status, 201, JSON.stringify(done.json)); // 如实完结、释放设备
  forceRunTimes(id2, base + 6_000, base + 11_000, 'aborted');

  d = await deviceStatus('CENT-Q');
  assert.equal(d.usedSeconds, 11);
  assert.equal(d.remainingSeconds, 0);
  assert.equal(d.overSeconds, 1);
  assert.equal(d.due, true);
  assert.equal(d.running, false);
  assert.equal(d.countedRuns, 2);

  // 达到上限：后续开始拒绝，409 附额度信息，且不留新运行
  r = await startRun('RQ-3-BLOCKED', 'CENT-Q');
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.maintenanceRequired, true);
  assert.equal(r.json.limitSeconds, 10);
  assert.equal(r.json.usedSeconds, 11);
  assert.equal(r.json.countedRuns, 2);
  assert.ok(r.json.errors.join(' ').includes('达到累计运行时长上限'));
  const runsOnDevice = db
    .prepare('SELECT COUNT(*) AS c FROM runs WHERE device_no = ?')
    .get('CENT-Q').c;
  assert.equal(runsOnDevice, 2);

  // 预约不应被失败的开始占用：失败的 run 使用了一个新预约，该预约仍可用于其他设备
  // （运行未创建，预约未被消费）——直接尝试以同设备另一编号仍因额度被拒，
  // 再对未设上限设备用全新预约开始验证整体流程未受污染。
  r = await startRun('RQ-NO-LIMIT', 'CENT-FREE');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  forceRunTimes(r.json.id, base, base + 30_000, 'completed');
  const free = await deviceStatus('CENT-FREE');
  assert.equal(free.limitSeconds, null);
  assert.equal(free.due, false);
  assert.equal(free.usedSeconds, 30);
  assert.equal(free.remainingSeconds, null);
});

test('登记保养：非法输入 400；设备运行中 409；成功后开启新累计周期', async () => {
  const base = Date.now();

  for (const bad of [
    null,
    {},
    { maintenanceNo: 'MT-Q-1', deviceNo: 'CENT-Q', reason: '' },
    { maintenanceNo: ' ', deviceNo: 'CENT-Q', reason: 'r' },
    { maintenanceNo: 'MT-Q-1', deviceNo: ' ', reason: 'r' },
  ]) {
    const r = await call('POST', '/api/maintenances', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }

  // 设备运行中拒绝（不留记录）
  const active = await startRun('RQ-BUSY', 'CENT-BUSY');
  assert.equal(active.status, 201, JSON.stringify(active.json));
  let r = await call('POST', '/api/maintenances', {
    maintenanceNo: 'MT-BUSY',
    deviceNo: 'CENT-BUSY',
    reason: '例行保养',
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.existingRunId, active.json.id);
  assert.ok(r.json.errors.join(' ').includes('进行中'));
  const busyMaint = await call('GET', `/api/devices/CENT-BUSY`);
  assert.equal(busyMaint.json.lastMaintenance, null);
  assert.ok(
    !(await call('GET', '/api/maintenances')).json.some((m) => m.maintenanceNo === 'MT-BUSY'),
  );

  // 完结释放后可登记
  await sleep(2);
  const finish = await call('POST', `/api/runs/${active.json.id}/complete`, { outcome: 'completed' });
  assert.equal(finish.status, 201);
  r = await call('POST', '/api/maintenances', {
    maintenanceNo: 'MT-BUSY',
    deviceNo: 'CENT-BUSY',
    reason: '例行保养',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.deviceNo, 'CENT-BUSY');
  assert.equal(r.json.reason, '例行保养');
  assert.ok(Math.abs(Date.parse(r.json.periodStartedAt) - Date.now()) < 5000);

  // CENT-Q：保养前累计 11s 已待保养；登记保养后周期归零（历史运行均开始于保养之前）
  r = await call('POST', '/api/maintenances', {
    maintenanceNo: 'MT-Q-1',
    deviceNo: 'CENT-Q',
    reason: '达到运行时长上限，例行保养',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const mtId = r.json.id;
  let d = await deviceStatus('CENT-Q');
  assert.equal(d.due, false);
  assert.equal(d.usedSeconds, 0);
  assert.equal(d.remainingSeconds, 10);
  assert.equal(d.countedRuns, 0);
  assert.equal(d.lastMaintenance.id, mtId);
  assert.equal(d.lastMaintenance.maintenanceNo, 'MT-Q-1');

  // 保养记录列表 / 单条
  const list = await call('GET', '/api/maintenances');
  assert.ok(list.json.some((m) => m.maintenanceNo === 'MT-Q-1'));
  const one = await call('GET', `/api/maintenances/${mtId}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.maintenanceNo, 'MT-Q-1');
  assert.equal((await call('GET', '/api/maintenances/999999')).status, 404);

  // 新周期运行 10 秒（恰达到上限，边界）→ 再次待保养
  const after = await startRun('RQ-AFTER', 'CENT-Q');
  assert.equal(after.status, 201, JSON.stringify(after.json));
  await sleep(2);
  const done = await call('POST', `/api/runs/${after.json.id}/complete`, { outcome: 'completed' });
  assert.equal(done.status, 201);
  const startMs = Date.parse(done.json.startUtc);
  forceRunTimes(after.json.id, startMs, startMs + 10_000, 'completed');
  d = await deviceStatus('CENT-Q');
  assert.equal(d.usedSeconds, 10);
  assert.equal(d.due, true);
  assert.equal(d.remainingSeconds, 0);
});

test('保养单号幂等：同号同内容 200 原记录；异内容 409（附 existingId）', async () => {
  const payload = {
    maintenanceNo: 'MT-Q-1',
    deviceNo: 'CENT-Q',
    reason: '达到运行时长上限，例行保养',
  };
  const same = await call('POST', '/api/maintenances', payload);
  assert.equal(same.status, 200);
  const list = await call('GET', '/api/maintenances');
  assert.equal(list.json.filter((m) => m.maintenanceNo === 'MT-Q-1').length, 1);

  let diff = await call('POST', '/api/maintenances', { ...payload, reason: '别的原因' });
  assert.equal(diff.status, 409);
  assert.ok(diff.json.existingId > 0);
  assert.ok(diff.json.errors.join(' ').includes('内容不同'));

  diff = await call('POST', '/api/maintenances', {
    maintenanceNo: 'MT-Q-1',
    deviceNo: 'CENT-BUSY',
    reason: '达到运行时长上限，例行保养',
  });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, same.json.id);
  // 异内容尝试不留新记录
  assert.equal(
    (await call('GET', '/api/maintenances')).json.filter((m) => m.maintenanceNo === 'MT-Q-1')
      .length,
    1,
  );
});

test('调整上限仅影响后续开始判定；删除上限恢复原行为；既有运行编号幂等重放不受额度影响', async () => {
  // 当前 CENT-Q：新周期已用 10s、上限 10s、待保养
  let d = await deviceStatus('CENT-Q');
  assert.equal(d.due, true);

  // 调大上限 → 不再待保养；历史运行与保养记录均不改写
  let r = await call('PUT', '/api/device-limits', { deviceNo: 'CENT-Q', limitSeconds: 3600 });
  assert.equal(r.status, 200);
  d = await deviceStatus('CENT-Q');
  assert.equal(d.due, false);
  assert.equal(d.usedSeconds, 10);
  assert.equal(d.remainingSeconds, 3590);

  // 调小上限 → 立即又待保养（不影响历史，只影响后续开始判定）
  await call('PUT', '/api/device-limits', { deviceNo: 'CENT-Q', limitSeconds: 5 });
  d = await deviceStatus('CENT-Q');
  assert.equal(d.due, true);
  assert.equal(d.overSeconds, 5);

  // 待保养期间：全新运行编号被拒
  const blocked = await startRun('RQ-BLOCKED-2', 'CENT-Q');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.maintenanceRequired, true);

  // 但既有运行编号以相同开始内容重放 → 200 原记录（幂等重放不重新核对额度）
  const afterRunId = db
    .prepare('SELECT id FROM runs WHERE run_no = ?')
    .get('RQ-AFTER').id;
  const replay = await call('POST', '/api/runs', {
    runNo: 'RQ-AFTER',
    deviceNo: 'CENT-Q',
    verificationId: v1,
    reservationId: db.prepare('SELECT reservation_id AS rid FROM runs WHERE id = ?').get(afterRunId).rid,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, afterRunId);

  // 删除上限 → 恢复原行为：新运行可开始，设备状态不再有待保养
  const del = await call('DELETE', '/api/device-limits/CENT-Q');
  assert.equal(del.status, 204);
  d = await deviceStatus('CENT-Q');
  assert.equal(d.limitSeconds, null);
  assert.equal(d.due, false);
  assert.equal(d.overSeconds, null);
  const freed = await startRun('RQ-UNLIMITED', 'CENT-Q');
  assert.equal(freed.status, 201, JSON.stringify(freed.json));
  await sleep(2);
  const finish = await call('POST', `/api/runs/${freed.json.id}/complete`, {
    outcome: 'completed',
  });
  assert.equal(finish.status, 201);

  // 删除不存在的上限同样 204（幂等）
  assert.equal((await call('DELETE', '/api/device-limits/NEVER')).status, 204);

  // 保养历史未被任何上限操作改写
  const maints = await call('GET', '/api/maintenances');
  assert.ok(maints.json.some((m) => m.maintenanceNo === 'MT-Q-1'));
});

test('未设上限设备的运行列表与完结行为完全沿用原语义（回归核对）', async () => {
  const runs = await call('GET', '/api/runs');
  // RQ-1、RQ-2、RQ-NO-LIMIT、RQ-BUSY、RQ-AFTER、RQ-UNLIMITED 至少六条
  assert.ok(runs.json.length >= 6, `runs=${runs.json.length}`);
  const state = await call('GET', '/api/state');
  const devNos = state.json.devices.map((x) => x.deviceNo);
  for (const expected of ['CENT-Q', 'CENT-FREE', 'CENT-BUSY']) {
    assert.ok(devNos.includes(expected), expected);
  }
  // 全部设备视图字段完整
  for (const d of state.json.devices) {
    assert.ok('due' in d && 'usedSeconds' in d && 'remainingSeconds' in d);
    assert.ok('running' in d && 'lastMaintenance' in d && 'countedRuns' in d);
  }
});
