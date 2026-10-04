// 设备累计运行时长与保养周期（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 可按设备编号设置「正整数秒数」的累计运行时长上限；未设上限的设备沿用原行为
//     （开始运行不做额度核对）；
//   - 自最近一次保养之后「已完结运行」的累计时长计入当前周期；尚无保养记录时，
//     计入该设备的全部已完结运行；完成（completed）与中止（aborted）一律按
//     服务端记录的起止时间（ended - started）计入，进行中（未完结）不提前计入；
//   - 累计按毫秒在服务端计算，对外以秒呈现（上限为整数秒，已用/剩余秒可含毫秒小数）；
//   - 达到上限（used >= limit）即为「待保养」：运行即使越过上限也如实完结，
//     但后续开始运行须在原事务内核对额度，达到上限即拒绝且不留新运行；
//   - 登记保养开启新累计周期（周期起点 = 保养登记的服务端时刻）：
//     仅开始时刻不早于周期起点的已完结运行计入新周期；
//   - 调整上限只影响后续开始判定，不改写任何运行与保养历史。

export const MS_PER_SECOND = 1000;

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// 上限设置请求规整：{ deviceNo, limitSeconds }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeLimitInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) return { errors: ['请求体必须是对象'], clean: null };

  const deviceNo = typeof b.deviceNo === 'string' ? b.deviceNo.trim() : '';
  if (!deviceNo) errors.push('设备编号不能为空');
  else if (deviceNo.length > 100) errors.push('设备编号过长（最多 100 字符）');

  // 正整数秒；布尔值会被 Number.isInteger 排除，浮点/0/负数均拒绝
  const limitSeconds = b.limitSeconds;
  if (!isInt(limitSeconds) || limitSeconds <= 0) {
    errors.push('上限必须是正整数秒数（按设备累计运行时长计时）');
  } else if (limitSeconds > 365 * 24 * 3600) {
    errors.push('上限定得过大（最多 365 天对应的秒数 31536000）');
  }

  if (errors.length) return { errors, clean: null };
  return { errors, clean: { deviceNo, limitSeconds } };
}

// 保养登记请求规整：{ maintenanceNo, deviceNo, reason }
export function normalizeMaintenanceInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) return { errors: ['请求体必须是对象'], clean: null };

  const maintenanceNo = typeof b.maintenanceNo === 'string' ? b.maintenanceNo.trim() : '';
  if (!maintenanceNo) errors.push('保养单号不能为空');
  else if (maintenanceNo.length > 100) errors.push('保养单号过长（最多 100 字符）');

  const deviceNo = typeof b.deviceNo === 'string' ? b.deviceNo.trim() : '';
  if (!deviceNo) errors.push('设备编号不能为空');
  else if (deviceNo.length > 100) errors.push('设备编号过长（最多 100 字符）');

  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) errors.push('保养原因不能为空');
  else if (reason.length > 200) errors.push('保养原因过长（最多 200 字符）');

  if (errors.length) return { errors, clean: null };
  return { errors, clean: { maintenanceNo, deviceNo, reason } };
}

// 单条已完结运行的时长（毫秒）：非完结（无 endedAt）返回 null；
// 起止时间非法或结束早于开始时按 0 处理（服务端正常数据不会出现）。
export function runDurationMs(run) {
  if (!run || !run.endedAt || !run.startUtc) return null;
  const start = Date.parse(run.startUtc);
  const end = Date.parse(run.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

// 统计一个保养周期内的已完结运行累计时长。
//   runs: [{ startUtc, endedAt }]（调用方负责按设备过滤）
//   sinceMs: 周期起点（最近一次保养的服务端时刻）；null 表示尚无保养、计入全部历史
// 返回 { usedMs, countedRuns, runs } —— runs 为被计入的运行下标（便于调试/明细）。
export function summarizeUsage({ runs, sinceMs = null }) {
  let usedMs = 0;
  let countedRuns = 0;
  const countedIndexes = [];
  for (let i = 0; i < runs.length; i += 1) {
    const r = runs[i];
    if (!r.endedAt) continue; // 进行中不提前计入
    const start = Date.parse(r.startUtc);
    if (!Number.isFinite(start)) continue;
    // 以「运行开始时刻」归属周期：开始于保养之前的运行属于上一周期
    if (sinceMs !== null && sinceMs !== undefined && start < sinceMs) continue;
    const d = runDurationMs(r);
    if (d === null) continue;
    usedMs += d;
    countedRuns += 1;
    countedIndexes.push(i);
  }
  return { usedMs, countedRuns, countedIndexes };
}

// 计算单台设备的额度视图。
//   limitSeconds: 正整数（仅在已设置上限时调用）；sinceMs: 最近保养时刻或 null
// 返回字段：
//   limitSeconds      上限（秒）
//   usedSeconds       本周期已完结运行累计时长（秒，毫秒精度）
//   remainingSeconds  剩余额度（秒，不为负；达到/越过上限为 0）
//   overSeconds       已超出上限的时长（秒，未超出为 0）
//   due               是否待保养（累计已达上限）
//   countedRuns       计入本周期的已完结运行数
export function quotaForDevice({ runs, limitSeconds, sinceMs = null }) {
  const limitMs = limitSeconds * MS_PER_SECOND;
  const { usedMs, countedRuns } = summarizeUsage({ runs, sinceMs });
  const due = usedMs >= limitMs;
  const remainingMs = Math.max(0, limitMs - usedMs);
  const overMs = Math.max(0, usedMs - limitMs);
  return {
    limitSeconds,
    usedSeconds: usedMs / MS_PER_SECOND,
    remainingSeconds: remainingMs / MS_PER_SECOND,
    overSeconds: overMs / MS_PER_SECOND,
    due,
    countedRuns,
  };
}
