"use strict";
/*
 * 药师帮「抗风控四件套」里的两件独立成库(v1.6.0, 自 ysbang.js 拆出):
 *   1) 缓存 —— 同词同参数在 TTL 内直接复用, 重复查询 0 请求
 *   2) 熔断 —— 探测到滑块/验证码立即停手冷却, 冷却期内快速失败不打页面
 * 同时新增持久化:
 *   - 缓存条目落盘(host 重启不丢, 免去重启后对同一品种重复打页面);
 *     落盘只保留最近 60 条(磁盘体积可控), 加载时丢弃超过 TTL 的旧条目。
 *   - 熔断冷却状态落盘 —— 这是安全关键: 被拦后 host 随浏览器重启, 若状态丢失
 *     会立刻继续撞网关; 落盘后冷却期跨重启生效。
 * 存储位置: %LOCALAPPDATA%\webtoopenapi\ysbang-cache.json(与默认参数持久化同目录)。
 * 独立成库的另一个动机: 缓存/熔断是纯状态逻辑, 不依赖浏览器, 可单独测试与观测。
 */
const fs = require("fs");
const path = require("path");
const { STATE_DIR } = require("../lib/config");
const { log } = require("../lib/log");

const DEFAULT_TTL_S = 12 * 3600;      // 缓存默认 12 小时(药师帮调价按天)
const CACHE_MAX = 200;                // 内存最多缓存 200 个查询, 超出淘汰最旧
const PERSIST_MAX = 60;               // 落盘最多保留最近 60 条, 控制文件体积
const BLOCK_COOLDOWN_MS = 15 * 60 * 1000; // 被拦后冷却 15 分钟

const cache = new Map();              // key -> { at, payload }
let blockState = { until: 0, at: 0, hits: 0 };

// 观测计数(供 /stats 读): 缓存命中/未命中/写入, 熔断累计
const counters = { cache_hits: 0, cache_misses: 0, cache_puts: 0, cache_expired: 0, block_marks: 0 };

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(STATE_DIR, "webtoopenapi", "ysbang-cache.json");
let loaded = false;
let saveTimer = null;

function scheduleSave(delayMs) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, delayMs);
}

function saveNow() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    // 只落最近 PERSIST_MAX 条(LRU 顺序即 Map 插入序, 从尾往前取)
    const entries = [...cache.entries()].slice(-PERSIST_MAX);
    const data = {
      saved_at: new Date().toISOString(),
      block: blockState,
      entries: entries.map(([k, v]) => [k, { at: v.at, payload: v.payload }]),
    };
    // 返回写入 Promise: 测试与需要确定性落盘的调用方可以 await
    return new Promise((resolve) => {
      fs.writeFile(STATE_FILE, JSON.stringify(data), "utf8", (e) => {
        if (e) log("warn", `ysbang cache persist failed: ${e.message}`);
        resolve(!e);
      });
    });
  } catch (e) {
    log("warn", `ysbang cache persist failed: ${e.message}`);
    return Promise.resolve(false);
  }
}

function loadOnce() {
  if (loaded) return;
  loaded = true;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return; // 无文件或损坏: 从零开始, 与旧行为一致
  }
  try {
    // 熔断状态: 冷却期未过才恢复; hits 累计保留(它只用于日志)
    if (data && data.block && Number(data.block.until) > Date.now()) {
      blockState = { until: Number(data.block.until), at: Number(data.block.at) || 0, hits: Number(data.block.hits) || 0 };
      log("info", `ysbang 熔断状态自磁盘恢复: 冷却剩余 ${Math.ceil((blockState.until - Date.now()) / 60000)} 分钟`);
    }
    // 缓存条目: 超过默认 TTL 的直接丢弃(条目可能带更长 ttl, 但宁可保守少复用)
    let restored = 0;
    if (data && Array.isArray(data.entries)) {
      for (const [k, v] of data.entries) {
        if (!k || !v || !Number.isFinite(v.at) || !v.payload || !Array.isArray(v.payload.items) || !v.payload.items.length) continue;
        if (Date.now() - v.at > DEFAULT_TTL_S * 1000) { counters.cache_expired++; continue; }
        cache.set(String(k), { at: v.at, payload: v.payload });
        restored++;
      }
      // 恢复后仍守 CACHE_MAX 上限
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    if (restored) log("info", `ysbang 缓存自磁盘恢复 ${restored} 条(${counters.cache_expired} 条过期丢弃): ${STATE_FILE}`);
  } catch (e) {
    log("warn", `ysbang cache load failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------
function cacheKey(p) {
  return [p.mode, p.q, p.pages, p.sort, p.top].join("|");
}

function cacheGet(p, ttlS) {
  loadOnce();
  if (!ttlS) return null;
  const hit = cache.get(cacheKey(p));
  if (!hit) { counters.cache_misses++; return null; }
  if (Date.now() - hit.at > ttlS * 1000) {
    cache.delete(cacheKey(p));
    counters.cache_expired++;
    return null;
  }
  counters.cache_hits++;
  return hit;
}

function cachePut(p, payload) {
  loadOnce();
  // 只缓存完整成功的结果; 被拦/报错的绝不入缓存
  if (!payload || !payload.items || !payload.items.length) return;
  const k = cacheKey(p);
  cache.delete(k); // 重新插入以刷新 LRU 顺序
  cache.set(k, { at: Date.now(), payload });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  counters.cache_puts++;
  scheduleSave(3000); // 防抖落盘: 3 秒内的连续写入合并成一次
}

// ---------------------------------------------------------------------------
// 熔断
// ---------------------------------------------------------------------------
function assertNotBlocked(p) {
  loadOnce();
  const left = blockState.until - Date.now();
  if (left > 0 && !p.reset_block) {
    const e = new Error(`药师帮风控冷却中, 还有 ${Math.ceil(left / 60000)} 分钟`);
    e.status = 429;
    e.hint =
      "上次探测到滑块/验证码, 已自动停手以免账号被标记。可在浏览器里手动过一次验证, " +
      "然后带 reset_block=1 立即恢复; 或等待冷却结束。";
    e.retry_after_s = Math.ceil(left / 1000);
    throw e;
  }
  if (p.reset_block) {
    blockState = { until: 0, at: blockState.at, hits: 0 };
    log("info", "ysbang block state reset by caller");
    scheduleSave(0); // 解除也要落盘, 否则重启后冷却又回来了
  }
}

function markBlocked(where) {
  blockState = { until: Date.now() + BLOCK_COOLDOWN_MS, at: Date.now(), hits: blockState.hits + 1 };
  counters.block_marks++;
  log("warn", `ysbang 命中风控(${where}), 冷却 ${BLOCK_COOLDOWN_MS / 60000} 分钟; 累计 ${blockState.hits} 次`);
  scheduleSave(0); // 立即落盘: host 若在此刻被重启, 冷却不能丢
}

function blockError(where) {
  const e = new Error(`药师帮弹出验证码(${where}), 已停止继续请求`);
  e.status = 429;
  e.hint =
    "页面出现滑块/图形验证。请在弹出的浏览器窗口里手动过一次, 然后重试; " +
    "若频繁出现, 改用 mode=cheapest(只取最低价, 2 次请求) 或降低调用频率。";
  throw e;
}

// ---------------------------------------------------------------------------
// 观测(供 /stats 读)
// ---------------------------------------------------------------------------
function stats() {
  loadOnce();
  return {
    cache: {
      size: cache.size,
      max: CACHE_MAX,
      hits: counters.cache_hits,
      misses: counters.cache_misses,
      puts: counters.cache_puts,
      expired: counters.cache_expired,
      persist_file: STATE_FILE,
      persist_pending: !!saveTimer,
    },
    block: {
      blocked: blockState.until > Date.now(),
      until: blockState.until > Date.now() ? new Date(blockState.until).toISOString() : null,
      remaining_s: blockState.until > Date.now() ? Math.ceil((blockState.until - Date.now()) / 1000) : 0,
      hits_total: blockState.hits,
      marks_since_reset: counters.block_marks,
    },
  };
}

// 供测试/手动清理: 清空缓存与冷却(不删磁盘文件)
function resetForTest() {
  cache.clear();
  blockState = { until: 0, at: 0, hits: 0 };
}

module.exports = {
  DEFAULT_TTL_S,
  CACHE_MAX,
  BLOCK_COOLDOWN_MS,
  STATE_FILE,
  cacheKey,
  cacheGet,
  cachePut,
  assertNotBlocked,
  markBlocked,
  blockError,
  stats,
  resetForTest,
  saveNow,
};
