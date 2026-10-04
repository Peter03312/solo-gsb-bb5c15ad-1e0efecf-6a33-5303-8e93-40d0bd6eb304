// Express 服务：REST API + 静态前端。
// 启动时自动建表；所有集合替换/发布均在 SQLite 事务中完成。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  loadData,
  currentHash,
  getDraft,
  saveDraft,
  listPublications,
  getPublication,
  insertPublication,
  getVerificationRow,
  getVerificationRowByPublication,
  createVerification,
  updateVerificationEntries,
  completeVerification,
  listVerificationRows,
  listReservationRows,
  getReservationRow,
  getReservationRowByBatch,
  listOverlappingActiveReservations,
  listActiveReservations,
  insertReservation,
  cancelReservation,
  listSuspensionRows,
  getSuspensionRow,
  listOverlappingActiveSuspensions,
  listActiveSuspensions,
  insertSuspension,
  revokeSuspension,
  listRunRows,
  getRunRow,
  getRunRowByRunNo,
  getRunRowByReservation,
  getActiveRunRowByDevice,
  insertRun,
  completeRun,
  getDeviceLimitRow,
  listDeviceLimitRows,
  upsertDeviceLimit,
  deleteDeviceLimit,
  getMaintenanceRow,
  getMaintenanceRowByNo,
  getLatestMaintenanceRow,
  listMaintenanceRows,
  insertMaintenance,
  listRunRowsByDevice,
} from './db.js';
import { solve, verify, computeHash } from './solver.js';
import { normalizeEntries, measureProgress, verifyMeasurements } from './verify.js';
import {
  parseUtcMs,
  toIso,
  planUsage,
  checkCapacity,
  checkSuspension,
  buildSchedule,
} from './reserve.js';
import {
  normalizeStartInput,
  normalizeCompleteInput,
  isWithinReservation,
  isOverrun,
} from './run.js';
import {
  normalizeLimitInput,
  normalizeMaintenanceInput,
  quotaForDevice,
  summarizeUsage,
} from './maintenance.js';
import {
  ValidationError,
  ConflictError,
  validateConfig,
  validateTubes,
  validateWeights,
  validateExclusions,
  validateFixedSlots,
} from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---------- 状态 ----------

  app.get('/api/state', (req, res) => {
    const data = loadData(db);
    const hash = data ? computeHash(data) : null;
    const rawDraft = getDraft(db);
    let draft = null;
    if (rawDraft) {
      draft = {
        ...rawDraft,
        stale: hash === null || rawDraft.basisHash !== hash,
      };
    }
    const publications = listPublications(db).map((p) => ({
      ...p,
      usable: hash !== null && p.feasible && p.basisHash === hash,
    }));
    res.json({
      data,
      currentHash: hash,
      draft,
      publications,
      verifications: serializeVerifications(db, hash),
      reservations: listReservationRows(db).map((r) =>
        reservationView(r, hash, Date.now()),
      ),
      suspensions: listSuspensionRows(db).map((r) => suspensionView(r, Date.now())),
      runs: listRunRows(db).map((r) => runView(r, hash, Date.now())),
      devices: listDeviceStatuses(db, Date.now()),
      maintenances: listMaintenanceRows(db).map((r) => maintenanceView(r)),
      deviceLimits: listDeviceLimitRows(db).map((r) => deviceLimitView(r)),
    });
  });

  // ---------- 转子配置（整体替换，事务） ----------

  app.put('/api/config', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateConfig(body, current);
        db.prepare('DELETE FROM hole_max').run();
        db.prepare('DELETE FROM config').run();
        db.prepare('INSERT INTO config (id, hole_count, tolerance) VALUES (1, ?, ?)').run(
          clean.holes,
          clean.tolerance,
        );
        const ins = db.prepare('INSERT INTO hole_max (hole, max_mass) VALUES (?, ?)');
        clean.holeMaxMass.forEach((m, h) => ins.run(h, m));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 离心管（整表替换，事务） ----------

  app.put('/api/tubes', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateTubes(body, N);
        // 替换离心管不得留下失效避邻对（对中管不再存在）：整次拒绝并保留原数据
        const ids = new Set(clean.map((t) => t.id));
        const dangling = (current ? current.exclusionPairs : []).filter(
          (p) => !ids.has(p.a) || !ids.has(p.b),
        );
        if (dangling.length > 0) {
          throw new ValidationError([
            '本次离心管替换会使现有避邻对失效（对中离心管不再存在），已拒绝并保留原数据：',
            ...dangling.map((p) => `避邻对「${p.a} ↔ ${p.b}」`),
            '请先解除相关避邻对，或保留对应离心管编号',
          ]);
        }
        // 替换离心管不得使现有固定孔位失效（管不再存在或孔位不再可用）：整次拒绝并保留原数据
        const newTubeMap = new Map(clean.map((t) => [t.id, t]));
        const brokenFixed = (current ? current.fixedSlots : []).filter((f) => {
          const t = newTubeMap.get(f.tube);
          return !t || !t.usableHoles.includes(f.hole);
        });
        if (brokenFixed.length > 0) {
          throw new ValidationError([
            '本次离心管替换会使现有固定孔位失效（管不再存在或孔位不再可用），已拒绝并保留原数据：',
            ...brokenFixed.map((f) => `固定孔位 ${f.hole}：离心管「${f.tube}」`),
            '请先解除相关固定孔位，或保留对应离心管编号与可用孔位',
          ]);
        }
        db.prepare('DELETE FROM tube_holes').run();
        db.prepare('DELETE FROM tubes').run();
        const insTube = db.prepare('INSERT INTO tubes (id, mass, ord) VALUES (?, ?, ?)');
        const insHole = db.prepare('INSERT INTO tube_holes (tube_id, hole) VALUES (?, ?)');
        clean.forEach((t, i) => {
          insTube.run(t.id, t.mass, i);
          for (const h of t.usableHoles) insHole.run(t.id, h);
        });
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 避邻对（整体替换，事务） ----------
  // 环形孔位中孔 i 与 (i+1) % N 相邻，同对两管不得相邻。
  // 未知编号、自配对、重复配对（含颠倒）任一出现即整次拒绝，不留下部分数据。

  app.get('/api/exclusions', (req, res) => {
    const data = loadData(db);
    res.json(data ? data.exclusionPairs : []);
  });

  app.put('/api/exclusions', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateExclusions(body, current);
        db.prepare('DELETE FROM exclusion_pairs').run();
        const ins = db.prepare(
          'INSERT INTO exclusion_pairs (tube_a, tube_b, ord) VALUES (?, ?, ?)',
        );
        clean.forEach((p, i) => ins.run(p.a, p.b, i));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 固定孔位（整体替换，事务） ----------
  // 实验人员预先摆好的离心管：按「管编号 + 孔位」整组保存/修改/清空。
  // 未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定，任一出现即整组拒绝，
  // 不留下部分数据（原绑定保留）。

  app.get('/api/fixed-slots', (req, res) => {
    const data = loadData(db);
    res.json(data ? data.fixedSlots : []);
  });

  app.put('/api/fixed-slots', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateFixedSlots(body, current);
        db.prepare('DELETE FROM fixed_slots').run();
        const ins = db.prepare(
          'INSERT INTO fixed_slots (tube_id, hole, ord) VALUES (?, ?, ?)',
        );
        clean.forEach((f, i) => ins.run(f.tube, f.hole, i));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块（整表替换，事务） ----------

  app.put('/api/weights', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateWeights(body, N);
        db.prepare('DELETE FROM weights').run();
        const ins = db.prepare('INSERT INTO weights (mass, quantity) VALUES (?, ?)');
        clean.forEach((w) => ins.run(w.mass, w.quantity));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 重算草稿 ----------

  app.post('/api/solve', (req, res, next) => {
    try {
      const data = loadData(db);
      if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
      const hash = computeHash(data);
      const result = solve(data);
      saveDraft(db, {
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
      res.json({
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 发布：事务内重读当前数据 → 求解 → 独立复核 → 冻结 ----------

  app.post('/api/publish', (req, res, next) => {
    try {
      let pubId;
      const tx = db.transaction(() => {
        const data = loadData(db);
        if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
        const hash = computeHash(data);
        const result = solve(data);
        if (!result.feasible) {
          throw new ValidationError([
            '当前数据不存在可行装载图，无法发布：',
            ...result.reasons,
          ]);
        }
        // 独立复核：不信任求解器输出本身
        const check = verify(data, result.arrangement);
        if (!check.ok) {
          throw new Error(`发布前独立复核失败：${check.errors.join('；')}`);
        }
        pubId = insertPublication(db, {
          basisHash: hash,
          feasible: true,
          weightCount: check.weightCount,
          diffSum: check.diffSum,
          config: data,
          result,
          reasons: [],
        });
      });
      tx();
      res.status(201).json(getPublication(db, pubId));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/publications', (req, res) => {
    const hash = currentHash(db);
    res.json(
      listPublications(db).map((p) => ({
        ...p,
        usable: hash !== null && p.feasible && p.basisHash === hash,
      })),
    );
  });

  app.get('/api/publications/:id', (req, res, next) => {
    const pub = getPublication(db, Number(req.params.id));
    if (!pub) return res.status(404).json({ error: '发布记录不存在' });
    const hash = currentHash(db);
    res.json({ ...pub, usable: pub.feasible && pub.basisHash === hash });
  });

  // ---------- 配重块时段预约 ----------
  //
  // 时段按左闭右开 [start, end) 计算；占用量按冻结装载图统计（各质量规格）。
  // 创建在单个事务内原子完成：重读冻结图、当前可选数量与重叠的生效中预约，
  // 任一时刻同规格预约总量不得超过当前录入数量；不足时返回冲突规格与时段，
  // 不产生任何部分占用。批次号为幂等键：同号同内容返回原记录（含已取消记录，
  // 不重新占用），同号不同内容拒绝。仅未开始的预约可取消，取消后历史保留。

  // 列表/详情视图：状态、阶段（相对当前时刻）、依据图当前可用性
  function reservationView(row, hash, nowMs) {
    const startMs = Date.parse(row.start_utc);
    const endMs = Date.parse(row.end_utc);
    const phase =
      row.status === 'cancelled'
        ? 'cancelled'
        : nowMs < startMs
          ? 'notStarted'
          : nowMs < endMs
            ? 'ongoing'
            : 'ended';
    return {
      id: row.id,
      batchNo: row.batch_no,
      publicationId: row.publication_id,
      startUtc: row.start_utc,
      endUtc: row.end_utc,
      usage: JSON.parse(row.usage_json),
      status: row.status,
      phase,
      cancellable: row.status === 'active' && nowMs < startMs,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      publicationUsable:
        hash !== null &&
        !!row.pub_basis_hash &&
        row.pub_basis_hash === hash &&
        !!row.pub_feasible,
    };
  }

  app.post('/api/reservations', (req, res, next) => {
    try {
      const body = req.body || {};
      const errors = [];
      const batchNo = typeof body.batchNo === 'string' ? body.batchNo.trim() : '';
      if (!batchNo) errors.push('批次号不能为空');
      else if (batchNo.length > 100) errors.push('批次号过长（最多 100 字符）');
      const publicationId = Number(body.publicationId);
      if (!Number.isInteger(publicationId) || publicationId <= 0) {
        errors.push('publicationId 必须是发布记录编号（正整数）');
      }
      const startMs = parseUtcMs(body.startUtc);
      const endMs = parseUtcMs(body.endUtc);
      if (startMs === null) errors.push('开始时间不是合法的 UTC 时间（ISO 8601）');
      if (endMs === null) errors.push('结束时间不是合法的 UTC 时间（ISO 8601）');
      if (startMs !== null && endMs !== null && !(startMs < endMs)) {
        errors.push('开始时间必须早于结束时间（时段按左闭右开 [start, end) 计算）');
      }
      if (errors.length) throw new ValidationError(errors);

      const startUtc = toIso(startMs);
      const endUtc = toIso(endMs);

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：同批次号重复提交——内容一致返回原记录（含已取消记录，不重新占用），
        // 内容不同拒绝。
        const existing = getReservationRowByBatch(db, batchNo);
        if (existing) {
          const same =
            existing.publication_id === publicationId &&
            existing.start_utc === startUtc &&
            existing.end_utc === endUtc;
          if (!same) {
            throw new ConflictError(
              [`批次号「${batchNo}」已被使用且预约内容不同，拒绝重复提交`],
              { existingId: existing.id },
            );
          }
          view = reservationView(existing, currentHash(db), Date.now());
          status = 200;
          return;
        }

        // 原子重读：冻结图、当前数量、重叠预约
        const pub = getPublication(db, publicationId);
        if (!pub) {
          throw new ValidationError([`发布记录 #${publicationId} 不存在（未知装载图）`]);
        }
        if (!pub.feasible) {
          throw new ValidationError([
            `发布记录 #${publicationId} 不含可行装载图，不能用于预约`,
          ]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），请选择仍可用的发布记录`,
          ]);
        }
        const data = loadData(db);
        const capacityOf = (mass) => {
          const w = data.weights.find((x) => x.mass === mass);
          return w ? w.quantity : 0;
        };
        const usage = planUsage(pub);
        const overlapping = listOverlappingActiveReservations(db, startUtc, endUtc).map(
          (r) => ({
            startMs: Date.parse(r.start_utc),
            endMs: Date.parse(r.end_utc),
            usage: JSON.parse(r.usage_json),
          }),
        );
        // 同时核对当前库存、重叠的生效停用：占用 + 停用任一时刻不得超过当前数量。
        // 停用允许与既有预约重叠，既有预约不因此改写。
        const suspOverlap = listOverlappingActiveSuspensions(db, startUtc, endUtc).map(
          (sp) => ({
            startMs: Date.parse(sp.start_utc),
            endMs: Date.parse(sp.end_utc),
            mass: sp.mass,
            count: sp.quantity,
          }),
        );
        const check = checkCapacity({
          usage,
          capacityOf,
          overlapping,
          suspensions: suspOverlap,
          startMs,
          endMs,
        });
        if (!check.ok) {
          const errs = ['当前可用数量不足（预约占用 + 生效停用超出当前库存），预约未产生任何占用：'];
          for (const c of check.conflicts) {
            for (const w of c.windows) {
              errs.push(
                `规格 ${c.mass} g：${w.start} 至 ${w.end} 已预约占用 ${w.used} 枚、` +
                  `临时停用 ${w.suspended} 枚，本次需 ${c.required} 枚，` +
                  `合计超出当前库存 ${c.capacity} 枚`,
              );
            }
          }
          throw new ConflictError(errs, { detail: { conflicts: check.conflicts } });
        }
        const row = insertReservation(db, {
          batchNo,
          publicationId,
          startUtc,
          endUtc,
          usage,
        });
        view = reservationView(row, hash, Date.now());
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/reservations', (req, res) => {
    const hash = currentHash(db);
    const nowMs = Date.now();
    res.json(listReservationRows(db).map((r) => reservationView(r, hash, nowMs)));
  });

  app.get('/api/reservations/:id', (req, res, next) => {
    const row = getReservationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '预约记录不存在' });
    res.json(reservationView(row, currentHash(db), Date.now()));
  });

  // 取消：仅未开始的预约可取消；已取消的预约幂等返回原记录（历史保留）
  app.post('/api/reservations/:id/cancel', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getReservationRow(db, id);
      if (!existed) return res.status(404).json({ error: '预约记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getReservationRow(db, id);
        if (row.status === 'cancelled') {
          view = reservationView(row, currentHash(db), Date.now());
          return;
        }
        const nowMs = Date.now();
        if (nowMs >= Date.parse(row.start_utc)) {
          throw new ConflictError([
            `预约 #${id} 已开始（${row.start_utc}），仅未开始的预约可取消`,
          ]);
        }
        const updated = cancelReservation(db, id, toIso(nowMs));
        if (!updated) throw new ConflictError([`预约 #${id} 状态已变化，请刷新后重试`]);
        view = reservationView(updated, currentHash(db), nowMs);
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // 预约日程：各质量规格在 [from, to) 内的分段占用/停用与「不足」区段。
  // segments.shortage 仅表示预约占用超过当前录入数量（字段含义不变）；
  // 另展示停用量（suspendedSegments）与「占用+停用」合计不足区段（combinedSegments）。
  // 既有预约/停用不因数量减少或图失效被改写。
  app.get('/api/schedule', (req, res, next) => {
    try {
      const active = listActiveReservations(db).map((r) => ({
        startMs: Date.parse(r.start_utc),
        endMs: Date.parse(r.end_utc),
        usage: JSON.parse(r.usage_json),
      }));
      const suspensions = listActiveSuspensions(db).map((sp) => ({
        startMs: Date.parse(sp.start_utc),
        endMs: Date.parse(sp.end_utc),
        mass: sp.mass,
        count: sp.quantity,
      }));
      const fromMs = parseUtcMs(req.query.from);
      const toMs = parseUtcMs(req.query.to);
      if (req.query.from !== undefined && fromMs === null) {
        throw new ValidationError(['from 不是合法的 UTC 时间（ISO 8601）']);
      }
      if (req.query.to !== undefined && toMs === null) {
        throw new ValidationError(['to 不是合法的 UTC 时间（ISO 8601）']);
      }
      const horizon = [
        ...active.map((r) => [r.startMs, r.endMs]),
        ...suspensions.map((sp) => [sp.startMs, sp.endMs]),
      ];
      const from =
        fromMs !== null
          ? fromMs
          : horizon.length
            ? Math.min(...horizon.map(([a]) => a))
            : Date.now();
      const to =
        toMs !== null
          ? toMs
          : horizon.length
            ? Math.max(...horizon.map(([, b]) => b))
            : from;
      if (!(from < to)) {
        if (from === to && horizon.length === 0) {
          return res.json({ from: toIso(from), to: toIso(to), specs: [] });
        }
        throw new ValidationError(['from 必须早于 to（时段按左闭右开 [from, to) 计算）']);
      }
      const data = loadData(db);
      const capacityOf = (mass) => {
        const w = data && data.weights.find((x) => x.mass === mass);
        return w ? w.quantity : 0;
      };
      const massSet = new Set();
      if (data) for (const w of data.weights) massSet.add(w.mass);
      for (const r of active) for (const u of r.usage) massSet.add(u.mass);
      for (const sp of suspensions) massSet.add(sp.mass);
      const specs = buildSchedule({
        reservations: active,
        suspensions,
        masses: [...massSet].sort((a, b) => a - b),
        capacityOf,
        fromMs: from,
        toMs: to,
      });
      res.json({ from: toIso(from), to: toIso(to), specs });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块临时停用 ----------
  //
  // 按质量规格登记停用数量、原因与 UTC 起止时间（左闭右开 [start, end)）。
  // 同规格重叠停用量累加；登记在单个事务内重读当前库存与重叠的生效停用，
  // 任一时刻停用量不得超过登记时该规格当前数量（停用可与既有预约重叠，
  // 既有预约不改写）。登记后即影响新预约：预约事务同时核对库存、停用与已有预约。
  // 仅未开始的停用可撤销，撤销留历史且释放后续容量。

  function suspensionView(row, nowMs) {
    const startMs = Date.parse(row.start_utc);
    const endMs = Date.parse(row.end_utc);
    const phase =
      row.status === 'revoked'
        ? 'revoked'
        : nowMs < startMs
          ? 'notStarted'
          : nowMs < endMs
            ? 'ongoing'
            : 'ended';
    return {
      id: row.id,
      mass: row.mass,
      quantity: row.quantity,
      reason: row.reason,
      startUtc: row.start_utc,
      endUtc: row.end_utc,
      status: row.status,
      phase,
      revocable: row.status === 'active' && nowMs < startMs,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  // 登记停用：非法时间/数量/未知规格 → 400；超量停用 → 409（附冲突规格与时段），
  // 任何失败均在事务内回滚，不留下记录。
  app.post('/api/suspensions', (req, res, next) => {
    try {
      const body = req.body || {};
      const errors = [];

      const mass = body.mass;
      if (typeof mass !== 'number' || !Number.isFinite(mass) || mass <= 0) {
        errors.push('mass 必须是有限正数（配重块质量规格，单位 g）');
      }
      const quantity = body.quantity;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push('停用数量必须是正整数');
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) errors.push('停用原因不能为空');
      else if (reason.length > 200) errors.push('停用原因过长（最多 200 字符）');

      const startMs = parseUtcMs(body.startUtc);
      const endMs = parseUtcMs(body.endUtc);
      if (startMs === null) errors.push('开始时间不是合法的 UTC 时间（ISO 8601）');
      if (endMs === null) errors.push('结束时间不是合法的 UTC 时间（ISO 8601）');
      if (startMs !== null && endMs !== null && !(startMs < endMs)) {
        errors.push('开始时间必须早于结束时间（时段按左闭右开 [start, end) 计算）');
      }
      if (errors.length) throw new ValidationError(errors);

      const startUtc = toIso(startMs);
      const endUtc = toIso(endMs);

      let view;
      const tx = db.transaction(() => {
        // 原子重读：当前库存（未知规格按当前录入判定）与重叠的生效停用
        const data = loadData(db);
        const spec = data && data.weights.find((w) => w.mass === mass);
        if (!spec) {
          throw new ValidationError([
            `未知质量规格 ${mass} g：当前配重块录入中不存在该规格，不能登记停用`,
          ]);
        }
        const overlapping = listOverlappingActiveSuspensions(db, startUtc, endUtc).map(
          (sp) => ({
            startMs: Date.parse(sp.start_utc),
            endMs: Date.parse(sp.end_utc),
            mass: sp.mass,
            count: sp.quantity,
          }),
        );
        const result = checkSuspension({
          mass,
          quantity,
          capacity: spec.quantity,
          overlapping,
          startMs,
          endMs,
        });
        if (!result.ok) {
          const c = result.conflict;
          const errs = ['停用量超出该规格当前数量，停用未登记：'];
          for (const w of c.windows) {
            errs.push(
              `规格 ${c.mass} g：${w.start} 至 ${w.end} 已停用 ${w.suspended} 枚，` +
                `本次再停用 ${c.required} 枚，超出当前库存 ${c.capacity} 枚`,
            );
          }
          throw new ConflictError(errs, { detail: { conflicts: [c] } });
        }
        const row = insertSuspension(db, {
          mass,
          quantity,
          reason,
          startUtc,
          endUtc,
        });
        view = suspensionView(row, Date.now());
      });
      tx();
      res.status(201).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/suspensions', (req, res) => {
    const nowMs = Date.now();
    res.json(listSuspensionRows(db).map((r) => suspensionView(r, nowMs)));
  });

  app.get('/api/suspensions/:id', (req, res) => {
    const row = getSuspensionRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '停用记录不存在' });
    res.json(suspensionView(row, Date.now()));
  });

  // 撤销：仅未开始的生效停用可撤销；已撤销幂等返回原记录（历史保留）；
  // 已开始/已结束 409。撤销立即释放后续容量（新预约可见）。
  app.post('/api/suspensions/:id/revoke', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getSuspensionRow(db, id);
      if (!existed) return res.status(404).json({ error: '停用记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getSuspensionRow(db, id);
        if (row.status === 'revoked') {
          view = suspensionView(row, Date.now());
          return;
        }
        const nowMs = Date.now();
        if (nowMs >= Date.parse(row.start_utc)) {
          throw new ConflictError([
            `停用 #${id} 已开始（${row.start_utc}），仅未开始的停用可撤销`,
          ]);
        }
        const updated = revokeSuspension(db, id, toIso(nowMs));
        if (!updated) throw new ConflictError([`停用 #${id} 状态已变化，请刷新后重试`]);
        view = suspensionView(updated, nowMs);
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 现场装载核验 ----------
  //
  // 流程：POST 选择可用发布记录建立草稿（同一发布记录只保留一份）→
  //       PUT 按孔位暂存实际物件编号/实测质量（携带 version 乐观锁，可反复暂存恢复）→
  //       POST .../complete 在单事务内重读发布快照与当前数据做最终判定。
  // 完成后结果冻结：重复完成不产生第二份结果，后续 PUT 被拒绝。

  // 列表项：进度 + 完成状态 + 发布记录当前可用性
  function verificationSummary(row, hash) {
    const pub = getPublication(db, row.publication_id);
    const entries = JSON.parse(row.entries_json);
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const completed = !!row.completed_at;
    return {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && !!row.pub_basis_hash && row.pub_basis_hash === hash,
      ...(completed
        ? { diffSum: row.diff_sum, massSum: row.mass_sum }
        : {}),
    };
  }

  function serializeVerifications(dbArg, hash) {
    return listVerificationRows(dbArg).map((row) => verificationSummary(row, hash));
  }

  // 详情（草稿或完成均返回；完成时附冻结的判定明细与冻结实测值）
  function verificationDetail(row) {
    const pub = getPublication(db, row.publication_id);
    const hash = currentHash(db);
    const entries = JSON.parse(row.entries_json);
    const completed = !!row.completed_at;
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const detail = {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && pub.feasible && pub.basisHash === hash,
      publication: {
        id: pub.id,
        createdAt: pub.createdAt,
        basisHash: pub.basisHash,
        config: pub.config,
        result: pub.result,
      },
      // 草稿阶段为当前暂存录入；完成后即为冻结实测值
      entries,
    };
    if (completed) {
      detail.diffSum = row.diff_sum;
      detail.massSum = row.mass_sum;
      detail.checks = JSON.parse(row.checks_json);
      detail.frozenEntries = JSON.parse(row.result_json);
    }
    return detail;
  }

  // 建立核验草稿：仅允许针对「当前仍可用」的可行发布记录
  app.post('/api/verifications', (req, res, next) => {
    try {
      const publicationId = Number(req.body && req.body.publicationId);
      if (!Number.isInteger(publicationId)) {
        throw new ValidationError(['publicationId 必须是发布记录编号（整数）']);
      }
      let detail;
      const tx = db.transaction(() => {
        const pub = getPublication(db, publicationId);
        if (!pub) throw new ValidationError(['发布记录不存在']);
        if (!pub.feasible) {
          throw new ValidationError([`发布记录 #${publicationId} 不含可行装载图，无法核验`]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），请选择仍可用的发布记录`,
          ]);
        }
        const existing = getVerificationRowByPublication(db, publicationId);
        if (existing) {
          throw new ConflictError(
            [
              existing.completed_at
                ? `发布记录 #${publicationId} 的核验已完成（结果已冻结），不能再建草稿`
                : `发布记录 #${publicationId} 已存在未完成核验，请直接恢复该草稿`,
            ],
            { existingId: existing.id, completed: !!existing.completed_at },
          );
        }
        const N = pub.config.holes;
        const emptyEntries = Array.from({ length: N }, (_, h) => ({
          hole: h,
          ref: '',
          mass: 0,
        }));
        const row = createVerification(db, publicationId, emptyEntries);
        detail = verificationDetail(row);
      });
      tx();
      res.status(201).json(detail);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/verifications', (req, res) => {
    res.json(serializeVerifications(db, currentHash(db)));
  });

  app.get('/api/verifications/:id', (req, res, next) => {
    const row = getVerificationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '核验记录不存在' });
    res.json(verificationDetail(row));
  });

  // 暂存：整表替换孔位录入；version 不匹配（他人已改）→ 409，拒绝覆盖
  app.put('/api/verifications/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const row0 = getVerificationRow(db, id);
      if (!row0) return res.status(404).json({ error: '核验记录不存在' });
      if (row0.completed_at) {
        throw new ConflictError(['核验已完成，实测值与判定结果已冻结，不能再修改']);
      }
      const expectedVersion = req.body && req.body.version;
      if (!Number.isInteger(expectedVersion)) {
        throw new ValidationError(['更新核验必须携带整数 version（用于防止覆盖他人修改）']);
      }
      if (expectedVersion !== row0.version) {
        throw new ConflictError(
          [`核验数据已被他人更新（当前版本 ${row0.version}），请先恢复最新草稿再提交`],
          { currentVersion: row0.version },
        );
      }
      const pub = getPublication(db, row0.publication_id);
      const { errors, entries } = normalizeEntries(req.body && req.body.entries, pub.config.holes);
      if (errors.length) throw new ValidationError(errors);

      const row = updateVerificationEntries(db, id, expectedVersion, entries);
      if (!row) {
        // 并发情况下版本/状态已被其他事务抢先改变
        const fresh = getVerificationRow(db, id);
        throw new ConflictError(
          [fresh && fresh.completed_at ? '核验刚被完成并冻结' : '核验版本已变化，请恢复最新草稿后再提交'],
          { currentVersion: fresh ? fresh.version : null },
        );
      }
      res.json(verificationDetail(row));
    } catch (e) {
      next(e);
    }
  });

  // 完成核验：同一事务内重读发布快照与当前数据并独立判定
  app.post('/api/verifications/:id/complete', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getVerificationRow(db, id);
      if (!existed) return res.status(404).json({ error: '核验记录不存在' });

      let status = 200;
      let detail;
      const tx = db.transaction(() => {
        const row = getVerificationRow(db, id);

        // 幂等：重复完成不产生第二份结果，直接返回冻结结果
        if (row.completed_at) {
          detail = verificationDetail(row);
          status = 200;
          return;
        }

        const pub = getPublication(db, row.publication_id);
        if (!pub || !pub.feasible) {
          throw new ValidationError([
            `发布记录 #${row.publication_id} 不含可行冻结装载图，无法完成核验`,
          ]);
        }
        // 发布记录仍可用于当前装载？
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${pub.id} 已不可用于当前装载（录入数据已变化），核验不能完成；草稿已保留`,
          ]);
        }

        // 重读当前暂存录入并做结构规整（不合法也保留草稿）
        const entries = JSON.parse(row.entries_json);
        const N = pub.config.holes;
        if (!Array.isArray(entries) || entries.length !== N) {
          throw new ValidationError(['暂存的核验录入与冻结图孔位数不符，草稿已保留']);
        }
        for (const e of entries) {
          const m = e && e.mass;
          const hasRef = e && typeof e.ref === 'string' && e.ref !== '';
          if (
            !e ||
            typeof m !== 'number' ||
            !Number.isFinite(m) ||
            (hasRef ? !(m > 0) : m !== 0)
          ) {
            throw new ValidationError([
              `孔 ${e ? e.hole : '?'} 录入不完整或质量非法：有物件时质量须为有限正数，空孔质量须为 0`,
            ]);
          }
        }

        // 独立判定：物件一致性、孔承重、对径容差（全部定位到孔位/孔对）
        const verdict = verifyMeasurements(
          { config: pub.config, result: pub.result },
          entries,
        );
        if (!verdict.ok) {
          throw new ValidationError(
            ['核验不通过，草稿已保留、未生成完成记录：', ...verdict.errors],
            { checks: verdict.checks, version: row.version },
          );
        }

        const updated = completeVerification(db, id, {
          checks: verdict.checks,
          diffSum: verdict.diffSum,
          massSum: verdict.massSum,
        });
        if (!updated) throw new Error('核验完成写入失败');
        detail = verificationDetail(updated);
        status = 201;
      });
      tx();
      res.status(status).json(detail);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 离心运行 ----------
  //
  // 实验人员以「唯一运行编号 + 非空设备编号 + 已完成核验编号 + 预约编号」开始一次
  // 离心运行；开始/结束时间由服务端记录。开始在单个事务内确认：
  //   1. 核验存在且已完成（核验结论已冻结）；
  //   2. 核验与生效预约指向同一张发布图；
  //   3. 发布图当前可用（数据指纹与当前录入一致、图可行）；
  //   4. 当前时刻处于预约左闭右开时段 [start, end)；
  //   5. 该预约未被其他运行使用（一个预约至多一次运行）；
  //   6. 同设备无进行中运行。
  // 任一冲突即 409 回滚，不留记录。开始后冻结发布图（编号/指纹/快照）、核验结论
  // 与预约时段。完结填写 completed/aborted，结束时间须晚于开始；超过预约终点仍如实
  // 完结并标记 timedOut，随即释放设备（部分唯一索引）；不改写预约。
  // 相同运行编号同开始内容重复提交返回原记录（200），异内容拒绝（409）；
  // 完结同状态重复提交返回原结果（200），异状态拒绝（409）。
  // 后续配置、库存或预约状态变化（含取消）均不改写已冻结的运行历史。

  function runView(row, hash, nowMs) {
    const ended = !!row.ended_at;
    const reservationEndMs = Date.parse(row.frozen_reservation_end_utc);
    const reservationStartMs = Date.parse(row.frozen_reservation_start_utc);
    const view = {
      id: row.id,
      runNo: row.run_no,
      deviceNo: row.device_no,
      verificationId: row.verification_id,
      reservationId: row.reservation_id,
      publicationId: row.publication_id,
      status: ended ? row.outcome : 'running',
      outcome: ended ? row.outcome : null,
      timedOut: !!row.timed_out,
      startUtc: row.start_utc,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      phase: ended
        ? 'ended'
        : nowMs >= reservationEndMs
          ? 'overrunning'
          : 'running',
      // 冻结依据（开始时写入，之后永不改写）
      frozenBasis: {
        publication: {
          id: row.publication_id,
          basisHash: row.frozen_basis_hash,
          feasible: !!row.frozen_pub_feasible,
          // 当前是否仍可用于装载（仅展示用，不影响冻结历史）
          currentlyUsable:
            hash !== null &&
            !!row.frozen_pub_feasible &&
            row.frozen_basis_hash === hash,
          config: JSON.parse(row.frozen_pub_config_json),
          result: JSON.parse(row.frozen_pub_result_json),
        },
        verification: {
          id: row.verification_id,
          passed: !!row.frozen_verification_passed,
          diffSum: row.frozen_verification_diff_sum,
          massSum: row.frozen_verification_mass_sum,
          checks: row.frozen_verification_checks_json
            ? JSON.parse(row.frozen_verification_checks_json)
            : null,
        },
        reservation: {
          id: row.reservation_id,
          startUtc: row.frozen_reservation_start_utc,
          endUtc: row.frozen_reservation_end_utc,
          usage: JSON.parse(row.frozen_reservation_usage_json),
        },
        // 展示用：预约当前状态快照（active/cancelled）；预约被取消不改写运行历史
        reservationCurrentStatus: null,
      },
    };
    const resRow = getReservationRow(db, row.reservation_id);
    if (resRow) view.frozenBasis.reservationCurrentStatus = resRow.status;
    // 运行中：now 相对冻结预约窗口的标记（已结束以 timedOut 为准）
    if (!ended) {
      view.withinReservationWindow = isWithinReservation(
        reservationStartMs,
        reservationEndMs,
        nowMs,
      );
    }
    return view;
  }

  // 开始运行：非法输入 400；核验/预约不存在等引用错误 400；状态/冲突类 409。
  app.post('/api/runs', (req, res, next) => {
    try {
      const { errors, clean } = normalizeStartInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { runNo, deviceNo, verificationId, reservationId } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：相同运行编号——开始内容一致返回原记录，不一致拒绝
        const existing = getRunRowByRunNo(db, runNo);
        if (existing) {
          const same =
            existing.device_no === deviceNo &&
            existing.verification_id === verificationId &&
            existing.reservation_id === reservationId;
          if (!same) {
            throw new ConflictError(
              [`运行编号「${runNo}」已被使用且开始内容不同，拒绝重复提交`],
              { existingId: existing.id },
            );
          }
          view = runView(existing, currentHash(db), Date.now());
          status = 200;
          return;
        }

        // 1. 核验存在且已完成（核验结论已冻结）
        const verRow = getVerificationRow(db, verificationId);
        if (!verRow) {
          throw new ValidationError([`核验记录 #${verificationId} 不存在（未知核验编号）`]);
        }
        if (!verRow.completed_at) {
          throw new ConflictError([
            `核验 #${verificationId} 尚未完成（核验结论未冻结），不能开始运行；请先完成现场装载核验`,
          ]);
        }

        // 2. 预约存在且生效中；核验与预约指向同一张发布图
        const resRow = getReservationRow(db, reservationId);
        if (!resRow) {
          throw new ValidationError([`预约记录 #${reservationId} 不存在（未知预约编号）`]);
        }
        if (resRow.status !== 'active') {
          throw new ConflictError([
            `预约 #${reservationId} 已取消，不能用于开始离心运行（历史预约保留）`,
          ]);
        }
        if (resRow.publication_id !== verRow.publication_id) {
          throw new ConflictError([
            `核验 #${verificationId} 依据发布图 #${verRow.publication_id}，` +
              `而预约 #${reservationId} 依据发布图 #${resRow.publication_id}，` +
              '二者必须指向同一张发布图',
          ]);
        }

        // 3. 发布图存在、可行且当前可用（数据指纹与当前录入一致）
        const pub = getPublication(db, verRow.publication_id);
        if (!pub) {
          throw new ValidationError([
            `发布记录 #${verRow.publication_id} 不存在（核验/预约的依据图缺失）`,
          ]);
        }
        if (!pub.feasible) {
          throw new ConflictError([
            `发布记录 #${pub.id} 不含可行装载图，不能用于开始运行`,
          ]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ConflictError([
            `发布记录 #${pub.id} 当前不可用于装载（录入数据已变化），不能开始运行；` +
              '既有核验与预约保留不变',
          ]);
        }

        // 4. 当前时刻处于预约左闭右开时段
        const nowMs = Date.now();
        const startMs = Date.parse(resRow.start_utc);
        const endMs = Date.parse(resRow.end_utc);
        if (!isWithinReservation(startMs, endMs, nowMs)) {
          throw new ConflictError([
            nowMs < startMs
              ? `当前时刻早于预约开始时间 ${resRow.start_utc}，运行尚未到开始时段`
              : `当前时刻已到/超过预约终点 ${resRow.end_utc}（时段左闭右开），不能开始运行`,
          ]);
        }

        // 5. 预约未被其他运行使用（UNIQUE 索引兜底，此处给出可读冲突）
        const usedBy = getRunRowByReservation(db, reservationId);
        if (usedBy) {
          throw new ConflictError([
            `预约 #${reservationId} 已用于运行 #${usedBy.id}（运行编号「${usedBy.run_no}」），` +
              '一个预约至多开始一次运行',
          ], { existingRunId: usedBy.id });
        }

        // 6. 同设备无进行中运行（部分唯一索引兜底，此处给出可读冲突）
        const activeOnDevice = getActiveRunRowByDevice(db, deviceNo);
        if (activeOnDevice) {
          throw new ConflictError([
            `设备「${deviceNo}」存在进行中的运行 #${activeOnDevice.id}` +
              `（运行编号「${activeOnDevice.run_no}」），请先完结该运行再开始新运行`,
          ], { existingRunId: activeOnDevice.id });
        }

        // 7. 设备累计运行时长额度核对（原事务内）：仅对已设置正整数秒上限的设备生效；
        //    自最近一次保养后的已完结运行（完成/中止均按服务端起止时间计入；进行中
        //    不提前计入）累计达到上限即拒绝且不留新运行。未设置上限沿用原行为。
        //    上限调整只影响此处判定，不改写运行/保养历史。
        const limitRow = getDeviceLimitRow(db, deviceNo);
        if (limitRow) {
          const lastMaint = getLatestMaintenanceRow(db, deviceNo);
          const sinceMs = lastMaint ? Date.parse(lastMaint.period_started_at) : null;
          const quota = quotaForDevice({
            runs: listRunRowsByDevice(db, deviceNo).map((r) => ({
              startUtc: r.start_utc,
              endedAt: r.ended_at,
            })),
            limitSeconds: limitRow.limit_seconds,
            sinceMs,
          });
          if (quota.due) {
            throw new ConflictError([
              `设备「${deviceNo}」自${lastMaint ? `最近一次保养（${lastMaint.period_started_at}）` : '全部历史'}起` +
                `已完结运行累计 ${formatSeconds(quota.usedSeconds)} 秒，` +
                `达到累计运行时长上限 ${quota.limitSeconds} 秒，须先登记保养（开启新累计周期）后再开始运行；` +
                '本次运行已拒绝，未留下任何记录',
            ], {
              maintenanceRequired: true,
              deviceNo,
              limitSeconds: quota.limitSeconds,
              usedSeconds: quota.usedSeconds,
              overSeconds: quota.overSeconds,
              countedRuns: quota.countedRuns,
              lastMaintenanceId: lastMaint ? lastMaint.id : null,
            });
          }
        }

        const row = insertRun(db, {
          runNo,
          deviceNo,
          verificationId,
          reservationId,
          publicationId: pub.id,
          startUtc: toIso(nowMs),
          basisHash: pub.basisHash,
          pubFeasible: pub.feasible,
          pubConfig: pub.config,
          pubResult: pub.result,
          verificationPassed: true, // 完成核验方可到达此处；结论随运行冻结
          verificationDiffSum: verRow.diff_sum,
          verificationMassSum: verRow.mass_sum,
          verificationChecks: verRow.checks_json ? JSON.parse(verRow.checks_json) : null,
          reservationStartUtc: resRow.start_utc,
          reservationEndUtc: resRow.end_utc,
          reservationUsage: JSON.parse(resRow.usage_json),
        });
        view = runView(row, hash, nowMs);
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/runs', (req, res) => {
    const hash = currentHash(db);
    const nowMs = Date.now();
    res.json(listRunRows(db).map((r) => runView(r, hash, nowMs)));
  });

  app.get('/api/runs/:id', (req, res, next) => {
    const row = getRunRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '运行记录不存在' });
    res.json(runView(row, currentHash(db), Date.now()));
  });

  // 完结运行：body.outcome = completed | aborted；结束时间由服务端记录且须晚于开始。
  // 超过预约终点仍如实完结并标记 timedOut；随即释放设备，不改写预约。
  // 重复提交：相同 outcome 返回原结果（200）；不同 outcome 拒绝（409）。
  app.post('/api/runs/:id/complete', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getRunRow(db, id);
      if (!existed) return res.status(404).json({ error: '运行记录不存在' });
      const { errors, clean } = normalizeCompleteInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { outcome } = clean;

      let status = 200;
      let view;
      const tx = db.transaction(() => {
        const row = getRunRow(db, id);
        if (row.ended_at) {
          // 幂等：同完结状态返回原结果；异状态拒绝
          if (row.outcome !== outcome) {
            throw new ConflictError([
              `运行 #${id} 已完结为「${row.outcome === 'completed' ? '完成' : '中止'}」，` +
                `不能改报为「${outcome === 'completed' ? '完成' : '中止'}」（完结状态已冻结）`,
            ], { existingOutcome: row.outcome });
          }
          view = runView(row, currentHash(db), Date.now());
          status = 200;
          return;
        }

        const endMs = Date.now();
        const startMs = Date.parse(row.start_utc);
        if (!(endMs > startMs)) {
          // 服务端时钟异常或与开始落在同一毫秒：拒绝并保持运行进行中
          throw new ConflictError([
            '结束时间未晚于开始时间（服务端时钟与开始时刻相同），请稍后重试完结',
          ]);
        }
        const timedOut = isOverrun(Date.parse(row.frozen_reservation_end_utc), endMs);
        const updated = completeRun(db, id, {
          outcome,
          endUtc: toIso(endMs),
          timedOut,
        });
        if (!updated) {
          // 并发：刚被其他请求完结
          const fresh = getRunRow(db, id);
          throw new ConflictError(
            [fresh ? `运行 #${id} 已被完结为「${fresh.outcome}」` : `运行 #${id} 状态已变化`],
            fresh ? { existingOutcome: fresh.outcome } : {},
          );
        }
        view = runView(updated, currentHash(db), endMs);
        status = 201;
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 设备累计运行时长上限与保养 ----------
  //
  // 实验室按设备「累计运行时长」安排保养：
  //   - 可按设备编号设置正整数秒数上限（PUT 整体替换该设备的上限；DELETE 恢复未设置）；
  //   - 自最近一次保养后「已完结运行」（completed/aborted 均按服务端起止时间）的累计
  //     时长计入当前周期；尚无保养记录时计入该设备全部已完结运行；进行中不提前计入；
  //   - 累计达到上限即「待保养」：运行即使越过上限也如实完结并释放设备，但后续开始
  //     运行须在开始运行的原事务内核对额度，达到上限即拒绝且不留新运行；
  //     未设置上限的设备沿用原行为；
  //   - 设备空闲时凭唯一保养单号、设备编号及原因登记保养，登记成功开启新累计周期；
  //     同号同内容重试返回原记录，异内容或设备运行中拒绝（409）；
  //   - 调整上限仅影响后续开始判定，不改写运行及保养历史；既有运行编号的幂等重放
  //     不重新核对额度（原运行接口输入/状态码/幂等/冻结依据保持兼容）。

  function formatSeconds(value) {
    return String(Math.round(value * 1000) / 1000);
  }

  function deviceLimitView(row) {
    return {
      deviceNo: row.device_no,
      limitSeconds: row.limit_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function maintenanceView(row) {
    return {
      id: row.id,
      maintenanceNo: row.maintenance_no,
      deviceNo: row.device_no,
      reason: row.reason,
      periodStartedAt: row.period_started_at,
      createdAt: row.created_at,
    };
  }

  // 单台设备状态：上限（可空）、本周期已完结累计/剩余/超出、待保养标记、
  // 是否有进行中运行、最近一次保养与累计依据的已完结运行条数。
  function buildDeviceStatus(deviceNo, nowMs) {
    const limitRow = getDeviceLimitRow(db, deviceNo);
    const lastMaint = getLatestMaintenanceRow(db, deviceNo);
    const sinceMs = lastMaint ? Date.parse(lastMaint.period_started_at) : null;
    const rows = listRunRowsByDevice(db, deviceNo);
    // 纯函数按 API 字段名（startUtc/endedAt）计时
    const runs = rows.map((r) => ({ startUtc: r.start_utc, endedAt: r.ended_at }));
    const active = rows.find((r) => !r.ended_at) || null;
    const base = {
      deviceNo,
      limitSeconds: limitRow ? limitRow.limit_seconds : null,
      running: !!active,
      activeRunId: active ? active.id : null,
      lastMaintenance: lastMaint ? maintenanceView(lastMaint) : null,
      totalRuns: runs.length,
    };
    if (!limitRow) {
      // 未设置上限：沿用原行为，但仍展示自最近保养后的已完结累计（仅供参考）
      const { usedMs, countedRuns } = summarizeUsage({ runs, sinceMs });
      return {
        ...base,
        due: false,
        usedSeconds: usedMs / 1000,
        remainingSeconds: null,
        overSeconds: null,
        countedRuns,
      };
    }
    const quota = quotaForDevice({ runs, limitSeconds: limitRow.limit_seconds, sinceMs });
    return {
      ...base,
      due: quota.due,
      usedSeconds: quota.usedSeconds,
      remainingSeconds: quota.remainingSeconds,
      overSeconds: quota.overSeconds,
      countedRuns: quota.countedRuns,
    };
  }

  // 汇总所有出现过的设备：运行记录中的设备 + 已设上限的设备 + 有保养记录的设备
  function listDeviceStatuses(nowMs) {
    const devices = new Set();
    for (const r of listRunRows(db)) devices.add(r.device_no);
    for (const r of listDeviceLimitRows(db)) devices.add(r.device_no);
    for (const r of listMaintenanceRows(db)) devices.add(r.device_no);
    return [...devices]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((deviceNo) => buildDeviceStatus(deviceNo, nowMs));
  }

  app.get('/api/devices', (req, res) => {
    res.json(listDeviceStatuses(Date.now()));
  });

  app.get('/api/devices/:deviceNo', (req, res) => {
    const deviceNo = req.params.deviceNo;
    const limitRow = getDeviceLimitRow(db, deviceNo);
    const lastMaint = getLatestMaintenanceRow(db, deviceNo);
    const seen = listRunRowsByDevice(db, deviceNo).length > 0;
    if (!limitRow && !lastMaint && !seen) {
      return res.status(404).json({ error: `设备「${deviceNo}」不存在任何运行、上限或保养记录` });
    }
    res.json(buildDeviceStatus(deviceNo, Date.now()));
  });

  // 上限列表（未出现在列表中的设备 = 未设置上限）
  app.get('/api/device-limits', (req, res) => {
    res.json(listDeviceLimitRows(db).map((r) => deviceLimitView(r)));
  });

  // 设置 / 调整上限（整值替换该设备上限）；仅影响后续开始判定。
  // 201 首次设置、200 调整既有上限。
  app.put('/api/device-limits', (req, res, next) => {
    try {
      const { errors, clean } = normalizeLimitInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { deviceNo, limitSeconds } = clean;
      const existed = !!getDeviceLimitRow(db, deviceNo);
      const row = upsertDeviceLimit(db, { deviceNo, limitSeconds });
      res.status(existed ? 200 : 201).json(deviceLimitView(row));
    } catch (e) {
      next(e);
    }
  });

  // 删除上限（恢复未设置的原行为）；未设置亦幂等返回 204。
  app.delete('/api/device-limits/:deviceNo', (req, res, next) => {
    try {
      deleteDeviceLimit(db, req.params.deviceNo);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // 保养记录列表 / 单条
  app.get('/api/maintenances', (req, res) => {
    res.json(listMaintenanceRows(db).map((r) => maintenanceView(r)));
  });

  app.get('/api/maintenances/:id', (req, res) => {
    const row = getMaintenanceRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '保养记录不存在' });
    res.json(maintenanceView(row));
  });

  // 登记保养：唯一保养单号 + 设备编号 + 原因；仅设备空闲可登记。
  // 同号同内容重试返回原记录（200），同号异内容 409，设备运行中 409，非法输入 400。
  app.post('/api/maintenances', (req, res, next) => {
    try {
      const { errors, clean } = normalizeMaintenanceInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { maintenanceNo, deviceNo, reason } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：同单号同内容返回原记录；同单号不同内容拒绝
        const existing = getMaintenanceRowByNo(db, maintenanceNo);
        if (existing) {
          const same = existing.device_no === deviceNo && existing.reason === reason;
          if (!same) {
            throw new ConflictError(
              [
                `保养单号「${maintenanceNo}」已被使用且登记内容不同，拒绝重复提交`,
              ],
              { existingId: existing.id },
            );
          }
          view = maintenanceView(existing);
          status = 200;
          return;
        }

        // 设备空闲：同设备无进行中运行（部分唯一索引兜底）
        const active = getActiveRunRowByDevice(db, deviceNo);
        if (active) {
          throw new ConflictError([
            `设备「${deviceNo}」存在进行中的运行 #${active.id}（运行编号「${active.run_no}」），` +
              '运行期间不能登记保养；请先完结该运行（完成/中止均会释放设备）',
          ], { existingRunId: active.id });
        }

        const row = insertMaintenance(db, {
          maintenanceNo,
          deviceNo,
          reason,
          startedAtUtc: toIso(Date.now()),
        });
        view = maintenanceView(row);
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 静态前端 ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- 错误处理 ----------

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res
        .status(400)
        .json({ error: err.message, errors: err.errors, ...(err.detail ? { detail: err.detail } : {}) });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({
        error: err.message,
        errors: err.errors,
        ...(err.existingId != null ? { existingId: err.existingId } : {}),
        ...(err.existingRunId != null ? { existingRunId: err.existingRunId } : {}),
        ...(err.existingOutcome != null ? { existingOutcome: err.existingOutcome } : {}),
        ...(err.completed != null ? { completed: err.completed } : {}),
        ...(err.currentVersion != null ? { currentVersion: err.currentVersion } : {}),
        ...(err.maintenanceRequired != null
          ? {
              maintenanceRequired: err.maintenanceRequired,
              deviceNo: err.deviceNo,
              limitSeconds: err.limitSeconds,
              usedSeconds: err.usedSeconds,
              overSeconds: err.overSeconds,
              countedRuns: err.countedRuns,
              lastMaintenanceId: err.lastMaintenanceId,
            }
          : {}),
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON', errors: ['请求体不是合法 JSON'] });
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误', errors: [String(err && err.message)] });
  });

  return app;
}

function start() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rotor.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const app = createApp(db);
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`离心转子配平服务已启动: http://localhost:${port}  (数据库: ${dbPath})`);
  });
}

// 仅在直接运行时监听端口（测试中 import 不触发）
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  start();
}
