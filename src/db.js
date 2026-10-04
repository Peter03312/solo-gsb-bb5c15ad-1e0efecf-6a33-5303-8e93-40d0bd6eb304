// SQLite 数据访问层。
// 所有“多记录集合”的写入都在单个事务内整体替换：
// 任何校验错误都会 ROLLBACK，不会留下部分数据。

import Database from 'better-sqlite3';
import { computeHash } from './solver.js';

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hole_count INTEGER NOT NULL,
  tolerance REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hole_max (
  hole INTEGER PRIMARY KEY,
  max_mass REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tubes (
  id TEXT PRIMARY KEY,
  mass REAL NOT NULL,
  ord INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tube_holes (
  tube_id TEXT NOT NULL REFERENCES tubes(id) ON DELETE CASCADE,
  hole INTEGER NOT NULL,
  PRIMARY KEY (tube_id, hole)
);

CREATE TABLE IF NOT EXISTS weights (
  mass REAL PRIMARY KEY,
  quantity INTEGER NOT NULL
);

-- 离心管避邻对：同对两管不得占据环形相邻孔位（i 与 (i+1)%N 相邻）。
-- 整体替换维护；对内按编号字典序规范化（tube_a < tube_b），整体按 (tube_a, tube_b)
-- 排序存储，使规则作为无序集合拥有稳定的数据指纹。
CREATE TABLE IF NOT EXISTS exclusion_pairs (
  tube_a TEXT NOT NULL,
  tube_b TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (tube_a, tube_b)
);

-- 固定孔位：实验人员预先摆好的离心管（管编号 → 孔位）。
-- 整体替换维护；每管最多一个固定孔位、每孔最多一支固定管（主键/唯一约束兜底），
-- 按孔位升序存取，使绑定作为无序集合拥有稳定的数据指纹。
CREATE TABLE IF NOT EXISTS fixed_slots (
  tube_id TEXT NOT NULL PRIMARY KEY,
  hole INTEGER NOT NULL UNIQUE,
  ord INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  reasons TEXT,
  result_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  weight_count INTEGER,
  diff_sum REAL,
  config_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  reasons TEXT
);

-- 配重块时段预约：batch_no 为幂等键（同批次号重复提交返回原记录、内容不同拒绝），
-- 取消仅置 status/cancelled_at，历史保留且批次号仍被占用（同号重试不重新占用）。
-- usage_json 为按冻结装载图统计的各质量规格占用量 [{mass, count}]，冻结不变。
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,
  publication_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  FOREIGN KEY (publication_id) REFERENCES publications(id)
);

-- 配重块临时停用：按质量规格记录停用数量、原因与 UTC 起止时间（左闭右开）。
-- 登记时已核对「任一时刻同规格重叠停用量 + 本数量不超过当时登记数量」，
-- 之后录入数量变化不改写既有停用；撤销仅置 status/revoked_at，历史保留。
-- mass 不设外键（规格允许从录入中删除，历史停用与历史预约一样保留）。
CREATE TABLE IF NOT EXISTS suspensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mass REAL NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- 现场装载核验：一条发布记录至多一份（草稿或完成），UNIQUE 约束兜底。
-- version 为乐观锁：每次暂存自增，更新须携带旧版本以防覆盖他人修改。
-- 完成后 completed_at 置位、result_json 冻结，之后草稿与完成结果均不可改写。
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  entries_json TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT,
  checks_json TEXT,
  diff_sum REAL,
  mass_sum REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (publication_id) REFERENCES publications(id)
);

-- 离心运行：以唯一运行编号开始；开始/结束时间由服务端记录。
-- 开始事务内确认核验通过、核验与预约同指一张发布图、发布图当前可用、
-- 当前时刻位于预约左闭右开时段、预约未被其他运行占用、同设备无进行中运行，
-- 通过后冻结发布图编号/数据指纹、核验编号与结论、预约编号与时段。
-- 完结仅置 outcome/ended_at/timed_out；不改写预约、不回填任何冻结列。
-- reservation_id 全局唯一：一个预约至多被一条运行使用；
-- 同设备「进行中（ended_at IS NULL）」至多一条由部分唯一索引兜底。
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL UNIQUE,
  device_no TEXT NOT NULL,
  verification_id INTEGER NOT NULL,
  reservation_id INTEGER NOT NULL,
  publication_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'aborted')),
  timed_out INTEGER NOT NULL DEFAULT 0,
  -- 冻结依据（开始时写入，之后永不改写）
  frozen_basis_hash TEXT NOT NULL,
  frozen_pub_feasible INTEGER NOT NULL,
  frozen_pub_config_json TEXT NOT NULL,
  frozen_pub_result_json TEXT NOT NULL,
  frozen_verification_passed INTEGER NOT NULL,
  frozen_verification_diff_sum REAL,
  frozen_verification_mass_sum REAL,
  frozen_verification_checks_json TEXT,
  frozen_reservation_start_utc TEXT NOT NULL,
  frozen_reservation_end_utc TEXT NOT NULL,
  frozen_reservation_usage_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (verification_id) REFERENCES verifications(id),
  FOREIGN KEY (reservation_id) REFERENCES reservations(id),
  FOREIGN KEY (publication_id) REFERENCES publications(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_reservation
  ON runs (reservation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_device_active
  ON runs (device_no) WHERE ended_at IS NULL;

-- 设备累计运行时长上限：按设备编号设置正整数秒数；不存在行 = 未设置上限，
-- 该设备开始运行沿用原行为（不核对额度）。调整上限仅影响后续开始判定，
-- 不改写任何运行与保养历史。
CREATE TABLE IF NOT EXISTS device_limits (
  device_no TEXT PRIMARY KEY,
  limit_seconds INTEGER NOT NULL CHECK (limit_seconds > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 设备保养登记：唯一保养单号为幂等键（同号同内容重试返回原记录，
-- 同号不同内容或设备运行中拒绝）。仅设备空闲（无进行中运行）时可登记，
-- 登记成功开启新的累计周期（period_started_at 为服务端时刻），
-- 仅开始时刻不早于该时刻的已完结运行计入新周期；历史永不改写。
CREATE TABLE IF NOT EXISTS maintenances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maintenance_no TEXT NOT NULL UNIQUE,
  device_no TEXT NOT NULL,
  reason TEXT NOT NULL,
  period_started_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenances_device
  ON maintenances (device_no, period_started_at);
`;

// ---------- 读取 ----------

export function loadData(db) {
  const cfg = db.prepare('SELECT hole_count, tolerance FROM config WHERE id = 1').get();
  if (!cfg) return null;
  const N = cfg.hole_count;
  const hmRows = db.prepare('SELECT hole, max_mass FROM hole_max').all();
  const holeMaxMass = new Array(N).fill(null);
  for (const r of hmRows) {
    if (r.hole >= 0 && r.hole < N) holeMaxMass[r.hole] = r.max_mass;
  }
  const tubes = db
    .prepare('SELECT id, mass, ord FROM tubes ORDER BY ord, rowid')
    .all()
    .map((t) => ({
      id: t.id,
      mass: t.mass,
      usableHoles: db
        .prepare('SELECT hole FROM tube_holes WHERE tube_id = ? ORDER BY hole')
        .pluck()
        .all(t.id),
    }));
  const weights = db
    .prepare('SELECT mass, quantity FROM weights ORDER BY mass')
    .all()
    .map((w) => ({ mass: w.mass, quantity: w.quantity }));
  const exclusionPairs = db
    .prepare('SELECT tube_a, tube_b FROM exclusion_pairs ORDER BY tube_a, tube_b')
    .all()
    .map((r) => ({ a: r.tube_a, b: r.tube_b }));
  const fixedSlots = db
    .prepare('SELECT tube_id, hole FROM fixed_slots ORDER BY hole, tube_id')
    .all()
    .map((r) => ({ tube: r.tube_id, hole: r.hole }));
  return {
    holes: N,
    tolerance: cfg.tolerance,
    holeMaxMass,
    tubes,
    weights,
    exclusionPairs,
    fixedSlots,
  };
}

export function currentHash(db) {
  const data = loadData(db);
  return data ? computeHash(data) : null;
}

export function getDraft(db) {
  const row = db.prepare('SELECT * FROM drafts WHERE id = 1').get();
  if (!row) return null;
  return {
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    result: JSON.parse(row.result_json),
    computedAt: row.computed_at,
    stale: false, // 由调用方结合当前哈希填写
  };
}

export function listPublications(db) {
  return db
    .prepare(
      `SELECT id, created_at, basis_hash, feasible, weight_count, diff_sum, reasons
       FROM publications ORDER BY id DESC`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      basisHash: r.basis_hash,
      feasible: !!r.feasible,
      weightCount: r.weight_count,
      diffSum: r.diff_sum,
      reasons: r.reasons ? JSON.parse(r.reasons) : [],
    }));
}

export function getPublication(db, id) {
  const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    weightCount: row.weight_count,
    diffSum: row.diff_sum,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    config: JSON.parse(row.config_json),
    result: JSON.parse(row.result_json),
  };
}

// ---------- 草稿 ----------

export function saveDraft(db, { basisHash, feasible, reasons, result }) {
  db.prepare(
    `INSERT INTO drafts (id, basis_hash, feasible, reasons, result_json)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       basis_hash = excluded.basis_hash,
       feasible = excluded.feasible,
       reasons = excluded.reasons,
       result_json = excluded.result_json,
       computed_at = datetime('now')`,
  ).run(basisHash, feasible ? 1 : 0, JSON.stringify(reasons ?? []), JSON.stringify(result));
}

// ---------- 发布（由 server 在单事务内调用） ----------

export function insertPublication(
  db,
  { basisHash, feasible, weightCount, diffSum, config, result, reasons },
) {
  const info = db
    .prepare(
      `INSERT INTO publications
         (basis_hash, feasible, weight_count, diff_sum, config_json, result_json, reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      basisHash,
      feasible ? 1 : 0,
      weightCount ?? null,
      diffSum ?? null,
      JSON.stringify(config),
      JSON.stringify(result),
      JSON.stringify(reasons ?? []),
    );
  return info.lastInsertRowid;
}

// ---------- 现场核验 ----------

export function getVerificationRow(db, id) {
  return db.prepare('SELECT * FROM verifications WHERE id = ?').get(id);
}

export function getVerificationRowByPublication(db, publicationId) {
  return db
    .prepare('SELECT * FROM verifications WHERE publication_id = ?')
    .get(publicationId);
}

export function createVerification(db, publicationId, entries) {
  const info = db
    .prepare(
      `INSERT INTO verifications (publication_id, version, entries_json)
       VALUES (?, 1, ?)`,
    )
    .run(publicationId, JSON.stringify(entries));
  return getVerificationRow(db, info.lastInsertRowid);
}

// 乐观锁更新：仅当草稿未完成且 version 匹配时写入；返回 null 表示未命中。
export function updateVerificationEntries(db, id, expectedVersion, entries) {
  const info = db
    .prepare(
      `UPDATE verifications
         SET entries_json = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ? AND completed_at IS NULL`,
    )
    .run(JSON.stringify(entries), id, expectedVersion);
  return info.changes === 1 ? getVerificationRow(db, id) : null;
}

// 完成：冻结判定结果（同一事务内由 server 重读快照并判定后调用）。
export function completeVerification(db, id, { checks, diffSum, massSum }) {
  const info = db
    .prepare(
      `UPDATE verifications
         SET completed_at = datetime('now'),
             result_json = entries_json,
             checks_json = ?,
             diff_sum = ?,
             mass_sum = ?,
             updated_at = datetime('now')
       WHERE id = ? AND completed_at IS NULL`,
    )
    .run(JSON.stringify(checks), diffSum, massSum, id);
  return info.changes === 1 ? getVerificationRow(db, id) : null;
}

// 核验列表（连发布表取冻结依据与发布编号）
export function listReservationRows(db) {
  return db
    .prepare(
      `SELECT r.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM reservations r
         JOIN publications p ON p.id = r.publication_id
        ORDER BY r.start_utc, r.id`,
    )
    .all();
}

export function getReservationRow(db, id) {
  return db
    .prepare(
      `SELECT r.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM reservations r
         JOIN publications p ON p.id = r.publication_id
        WHERE r.id = ?`,
    )
    .get(id);
}

export function getReservationRowByBatch(db, batchNo) {
  return db
    .prepare(
      `SELECT r.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM reservations r
         JOIN publications p ON p.id = r.publication_id
        WHERE r.batch_no = ?`,
    )
    .get(batchNo);
}

// 与 [startIso, endIso) 重叠的生效中预约（左闭右开：r.start < end 且 start < r.end）
export function listOverlappingActiveReservations(db, startIso, endIso) {
  return db
    .prepare(
      `SELECT * FROM reservations
        WHERE status = 'active' AND start_utc < ? AND ? < end_utc`,
    )
    .all(endIso, startIso);
}

export function listActiveReservations(db) {
  return db.prepare(`SELECT * FROM reservations WHERE status = 'active'`).all();
}

export function insertReservation(db, { batchNo, publicationId, startUtc, endUtc, usage }) {
  const info = db
    .prepare(
      `INSERT INTO reservations (batch_no, publication_id, start_utc, end_utc, usage_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(batchNo, publicationId, startUtc, endUtc, JSON.stringify(usage));
  return getReservationRow(db, info.lastInsertRowid);
}

// 取消：仅生效中且未开始的预约可取消（条件更新，未命中返回 null）。
export function cancelReservation(db, id, nowIso) {
  const info = db
    .prepare(
      `UPDATE reservations
          SET status = 'cancelled', cancelled_at = ?
        WHERE id = ? AND status = 'active' AND start_utc > ?`,
    )
    .run(nowIso, id, nowIso);
  return info.changes === 1 ? getReservationRow(db, id) : null;
}

// ---------- 配重块临时停用（由 server 在单事务内调用） ----------

export function listSuspensionRows(db) {
  return db
    .prepare(`SELECT * FROM suspensions ORDER BY start_utc, id`)
    .all();
}

export function getSuspensionRow(db, id) {
  return db.prepare('SELECT * FROM suspensions WHERE id = ?').get(id);
}

// 与 [startIso, endIso) 重叠的生效中停用（左闭右开：start < end 且自身 start < endIso）
export function listOverlappingActiveSuspensions(db, startIso, endIso) {
  return db
    .prepare(
      `SELECT * FROM suspensions
        WHERE status = 'active' AND start_utc < ? AND ? < end_utc`,
    )
    .all(endIso, startIso);
}

export function listActiveSuspensions(db) {
  return db.prepare(`SELECT * FROM suspensions WHERE status = 'active'`).all();
}

export function insertSuspension(db, { mass, quantity, reason, startUtc, endUtc }) {
  const info = db
    .prepare(
      `INSERT INTO suspensions (mass, quantity, reason, start_utc, end_utc)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(mass, quantity, reason, startUtc, endUtc);
  return getSuspensionRow(db, info.lastInsertRowid);
}

// 撤销：仅生效中且未开始的停用可撤销（条件更新，未命中返回 null）。
export function revokeSuspension(db, id, nowIso) {
  const info = db
    .prepare(
      `UPDATE suspensions
          SET status = 'revoked', revoked_at = ?
        WHERE id = ? AND status = 'active' AND start_utc > ?`,
    )
    .run(nowIso, id, nowIso);
  return info.changes === 1 ? getSuspensionRow(db, id) : null;
}

// 核验列表（连发布表取冻结依据与发布编号）
export function listVerificationRows(db) {
  return db
    .prepare(
      `SELECT v.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM verifications v
         JOIN publications p ON p.id = v.publication_id
        ORDER BY v.id DESC`,
    )
    .all();
}

// ---------- 离心运行（由 server 在单事务内调用） ----------

export function getRunRow(db, id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

export function getRunRowByRunNo(db, runNo) {
  return db.prepare('SELECT * FROM runs WHERE run_no = ?').get(runNo);
}

export function getRunRowByReservation(db, reservationId) {
  return db.prepare('SELECT * FROM runs WHERE reservation_id = ?').get(reservationId);
}

export function getActiveRunRowByDevice(db, deviceNo) {
  return db
    .prepare('SELECT * FROM runs WHERE device_no = ? AND ended_at IS NULL')
    .get(deviceNo);
}

export function listRunRows(db) {
  return db.prepare('SELECT * FROM runs ORDER BY start_utc DESC, id DESC').all();
}

// 开始运行：冻结依据快照在同一事务内写入（basis 字段由 server 收集）。
export function insertRun(db, b) {
  const info = db
    .prepare(
      `INSERT INTO runs (
         run_no, device_no, verification_id, reservation_id, publication_id,
         start_utc,
         frozen_basis_hash, frozen_pub_feasible,
         frozen_pub_config_json, frozen_pub_result_json,
         frozen_verification_passed, frozen_verification_diff_sum,
         frozen_verification_mass_sum, frozen_verification_checks_json,
         frozen_reservation_start_utc, frozen_reservation_end_utc,
         frozen_reservation_usage_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.runNo,
      b.deviceNo,
      b.verificationId,
      b.reservationId,
      b.publicationId,
      b.startUtc,
      b.basisHash,
      b.pubFeasible ? 1 : 0,
      JSON.stringify(b.pubConfig),
      JSON.stringify(b.pubResult),
      b.verificationPassed ? 1 : 0,
      b.verificationDiffSum ?? null,
      b.verificationMassSum ?? null,
      b.verificationChecks === undefined
        ? null
        : JSON.stringify(b.verificationChecks ?? null),
      b.reservationStartUtc,
      b.reservationEndUtc,
      JSON.stringify(b.reservationUsage ?? []),
    );
  return getRunRow(db, info.lastInsertRowid);
}

// 完结：条件更新保证幂等与状态约束（仅进行中可完结）。
export function completeRun(db, id, { outcome, endUtc, timedOut }) {
  const info = db
    .prepare(
      `UPDATE runs
          SET outcome = ?, ended_at = ?, timed_out = ?
        WHERE id = ? AND ended_at IS NULL AND outcome IS NULL`,
    )
    .run(outcome, endUtc, timedOut ? 1 : 0, id);
  return info.changes === 1 ? getRunRow(db, id) : null;
}

// ---------- 设备累计运行时长上限与保养 ----------

export function getDeviceLimitRow(db, deviceNo) {
  return db.prepare('SELECT * FROM device_limits WHERE device_no = ?').get(deviceNo);
}

export function listDeviceLimitRows(db) {
  return db.prepare('SELECT * FROM device_limits ORDER BY device_no').all();
}

export function upsertDeviceLimit(db, { deviceNo, limitSeconds }) {
  db.prepare(
    `INSERT INTO device_limits (device_no, limit_seconds)
     VALUES (?, ?)
     ON CONFLICT(device_no) DO UPDATE SET
       limit_seconds = excluded.limit_seconds,
       updated_at = datetime('now')`,
  ).run(deviceNo, limitSeconds);
  return getDeviceLimitRow(db, deviceNo);
}

// 删除上限（恢复未设置行为）；返回是否命中既有行。
export function deleteDeviceLimit(db, deviceNo) {
  const info = db.prepare('DELETE FROM device_limits WHERE device_no = ?').run(deviceNo);
  return info.changes === 1;
}

export function getMaintenanceRowByNo(db, maintenanceNo) {
  return db.prepare('SELECT * FROM maintenances WHERE maintenance_no = ?').get(maintenanceNo);
}

export function getMaintenanceRow(db, id) {
  return db.prepare('SELECT * FROM maintenances WHERE id = ?').get(id);
}

export function listMaintenanceRows(db) {
  return db.prepare('SELECT * FROM maintenances ORDER BY period_started_at DESC, id DESC').all();
}

// 设备最近一次保养（当前累计周期起点）；无记录返回 null。
export function getLatestMaintenanceRow(db, deviceNo) {
  return db
    .prepare(
      `SELECT * FROM maintenances
        WHERE device_no = ?
        ORDER BY period_started_at DESC, id DESC
        LIMIT 1`,
    )
    .get(deviceNo);
}

export function insertMaintenance(db, { maintenanceNo, deviceNo, reason, startedAtUtc }) {
  const info = db
    .prepare(
      `INSERT INTO maintenances (maintenance_no, device_no, reason, period_started_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(maintenanceNo, deviceNo, reason, startedAtUtc);
  return getMaintenanceRow(db, info.lastInsertRowid);
}

// 某设备的全部运行（调用方用 summarizeUsage 按时点过滤已完结/进行中）。
export function listRunRowsByDevice(db, deviceNo) {
  return db
    .prepare('SELECT * FROM runs WHERE device_no = ? ORDER BY start_utc, id')
    .all(deviceNo);
}
