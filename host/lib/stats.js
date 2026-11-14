"use strict";
/*
 * 请求观测(v1.6.0): 进程内计数器, 供 GET /stats 读。
 * 只做内存统计, 不落盘 —— host 由浏览器经 native messaging 拉起, 生命周期本来就短,
 * 落盘累积没有意义; 重启即从零计, 看 /stats 即当次运行的情况。
 *   label: 路由标签(如 "GET /api/v1/ysbang/price", 工具透传 "/api/v1/tools/<name>", MCP "/mcp")
 *   每个 bucket: count / errors(status>=400) / total_ms / max_ms / last_ms / last_at
 */
const buckets = new Map();

function record(label, status, ms) {
  let b = buckets.get(label);
  if (!b) {
    b = { count: 0, errors: 0, total_ms: 0, max_ms: 0, last_ms: 0, last_status: 0, last_at: null };
    buckets.set(label, b);
  }
  b.count++;
  if (Number(status) >= 400) b.errors++;
  const n = Number(ms) || 0;
  b.total_ms += n;
  if (n > b.max_ms) b.max_ms = n;
  b.last_ms = n;
  b.last_status = Number(status) || 0;
  b.last_at = new Date().toISOString();
}

// 每个 label 派生 p50 无法从增量做到, 只给均值/最大值/最近一次 —— 对定位"哪个端点慢"已够用
function snapshot() {
  const out = [];
  for (const [label, b] of buckets) {
    out.push({
      label,
      count: b.count,
      errors: b.errors,
      avg_ms: b.count ? Math.round(b.total_ms / b.count) : 0,
      max_ms: b.max_ms,
      last_ms: b.last_ms,
      last_status: b.last_status,
      last_at: b.last_at,
    });
  }
  out.sort((a, z) => z.count - a.count || a.label.localeCompare(z.label));
  const total = out.reduce((s, b) => s + b.count, 0);
  const errors = out.reduce((s, b) => s + b.errors, 0);
  return { since_reset: { total, errors }, endpoints: out };
}

function reset() {
  buckets.clear();
}

module.exports = { record, snapshot, reset };
