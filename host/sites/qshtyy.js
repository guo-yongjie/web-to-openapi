"use strict";
/*
 * 站点: 海豚药药极速版(https://pc.qshtyy.com) —— 兰州强生医药集团 B2B 采购平台
 * ---------------------------------------------------------------------------
 * 与药师帮的区别(决定了本文件的写法):
 *   药师帮: DOM 抽取 + 字体连字反爬 + 解密挂钩 + 翻页等待, 1411 行;
 *   本站  : 标准 JSON 接口, 价格明文, 无字体混淆 —— 页面内两次 POST 就拿到全字段。
 *
 * 两段式接口(实测 2026-11-14, 均需请求头 token):
 *   1) POST /api/goods/search/onCondition
 *      body  {channelType:0, columnType:0, pageNumber:1, pageSize:N, newCategoryLabelId:-1,
 *             manufacturer:[], specification:[], keyWords:"<词>", searchType:0}
 *      resp  {code:200, content:{list:[{goodsId,goodsName,containSpecial}], totalRecords, totalPage,...}}
 *      ⚠ 只给 id + 品名, 价格/库存/效期都在第二段。
 *   2) POST /api/goods/goodsInfo/list
 *      body  {goodsIdList:[...], limitSize:N, limitStart:0}   resp {code:200, content:[{...全字段}]}
 *      实测 limitSize=200 可一次回 200 条; 本文件按 200 分块, 不赌服务端上限。
 *
 * 认证: 请求头 `token: <localStorage.token>`, 不是 Cookie、不是 Authorization。
 *   两者都试过(实测): 只带 Cookie -> code:401 "登录已过期"; 带 token 头 -> code:200。
 *   所以页面内脚本第一件事就是读 localStorage.token, 读不到直接判登录失效。
 *
 * 三个为什么:
 *   1) 为什么页面内先裁剪字段再回传 —— 60 条全字段原始 JSON 是 121KB(均条 2028 字节)。
 *      扩展对「单字符串」返回值有 10KB 截断, 且大对象传输慢; 页面内映射成短键后
 *      100 条约 20KB, host 侧再还原成可读字段名(见 mapItem)。
 *   2) 为什么优先复用已有标签 —— 该站每开一个全新标签要跑 20+ 个初始化请求(热词/广告/配置)。
 *      用户浏览器里通常已开着本站(实测已登录), 直接复用 = 0 额外请求、耗时从 ~12s 降到 <1.5s。
 *      只读 localStorage + 发 fetch, 不改用户页面状态, 所以复用的标签不关。
 *   3) 为什么缓存只有 5 分钟内存版 —— 站点数据变动不快, 但也没有药师帮那种「请求一次就多一分
 *      风控暴露」的压力; 5 分钟足够吸收「同一个词连问几次」的重复, 又不至于给出过时价格。
 */
const {
  openPage, closePage, jsEval, needsHuman, sleep, num, toSearchParams,
  truthy, dataText, callTool, withBrowserSlot,
} = require("../lib/util");
const { log } = require("../lib/log");
const registry = require("../lib/registry");

const TAB_URL = "https://pc.qshtyy.com/#/searchList";
const TAB_HOST = "pc.qshtyy.com";
const DEFAULT_LIMIT = 100; // 用户指定默认 100
const MAX_LIMIT = 300;     // 明细接口分块 200, 300 最多两轮
const DETAIL_CHUNK = 200;  // 实测 limitSize=200 可一次回 200 条
const BATCH_MAX = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 60;

// ---------------------------------------------------------------------------
// 5 分钟内存缓存(纯内存, 不落盘: 价格时效性强, 重启后重新采集更安全)
// ---------------------------------------------------------------------------
const cache = new Map(); // key -> { at, payload }

function cacheKey(p) {
  return [String(p.q).trim().toLowerCase(), p.limit].join("|");
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit;
}

function cachePut(key, payload) {
  if (cache.size >= CACHE_MAX) {
    // 先清过期, 仍满则丢最旧的一条(Map 保持插入顺序)
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  cache.set(key, { at: Date.now(), payload });
}

// ---------------------------------------------------------------------------
// 页面内脚本: 两段式接口 + 字段裁剪, return 对象(不要 JSON.stringify —— 单字符串有 10KB 截断)
// ---------------------------------------------------------------------------
const EXTRACT_JS = `
const H = { "Content-Type": "application/json" };
let TK = "";
try { TK = localStorage.getItem("token") || ""; } catch (e) {}
if (!TK) return { error: "no_token" };
H.token = TK;

const Q = __Q__;
const LIMIT = __LIMIT__;
const CHUNK = __CHUNK__;

async function post(path, body) {
  let r;
  try {
    r = await fetch(path, { method: "POST", headers: H, credentials: "include", body: JSON.stringify(body) });
  } catch (e) {
    return { error: "network", message: String((e && e.message) || e) };
  }
  let j = null;
  try { j = await r.json(); } catch (e) { return { error: "bad_json", status: r.status }; }
  return j || { error: "empty_body", status: r.status };
}

// 第一段: 关键词 -> 命中 id 列表 + 总数
const j1 = await post("/api/goods/search/onCondition", {
  channelType: 0, columnType: 0, pageNumber: 1, pageSize: LIMIT, newCategoryLabelId: -1,
  manufacturer: [], specification: [], keyWords: Q, searchType: 0
});
if (j1.error) return j1;
if (j1.code === 401) return { error: "unauthorized", message: j1.message || "" };
if (j1.code !== 200) return { error: "api_error", code: j1.code, message: j1.message || "" };

const c1 = j1.content || {};
const ids = (c1.list || []).map(function (x) { return x && x.goodsId; }).filter(function (x) { return x != null; });
const total = c1.totalRecords == null ? ids.length : c1.totalRecords;
if (!ids.length) return { total: 0, items: [] };

// 第二段: id -> 明细(分块, 不赌服务端单次上限)
const want = ids.slice(0, LIMIT);
const byId = {};
for (let off = 0; off < want.length; off += CHUNK) {
  const part = want.slice(off, off + CHUNK);
  const j2 = await post("/api/goods/goodsInfo/list", { goodsIdList: part, limitSize: part.length, limitStart: 0 });
  if (j2.error) return j2;
  if (j2.code === 401) return { error: "unauthorized", message: j2.message || "" };
  if (j2.code !== 200) return { error: "api_error", code: j2.code, message: j2.message || "" };
  const arr = Array.isArray(j2.content) ? j2.content : [];
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x && x.id != null) byId[x.id] = x;
  }
}

// 按搜索命中顺序输出; 短键只为压体积, 还原在 host 侧 mapItem
const items = [];
for (let i = 0; i < want.length; i++) {
  const x = byId[want[i]];
  if (!x) continue;
  items.push({
    i: x.id, n: x.name || "", s: x.specification || "", m: x.manufacturerName || "",
    p: x.sellingPrice, rp: x.retailPrice, mp: x.marketPrice, sq: x.quantity,
    e: x.expirationDate || "", mo: x.minimum, pk: x.packages, pc: x.piece, u: x.unit || "",
    ap: x.licenseNumber || "", ins: x.ybfl || "", tg: x.cgbeizhu || "", ct: x.type || "",
    lb: Array.isArray(x.label) ? x.label.join(",") : ""
  });
}
return { total: total, items: items };
`;

function buildJs(q, limit) {
  return EXTRACT_JS
    .replace("__Q__", JSON.stringify(String(q)))
    .replace("__LIMIT__", String(limit))
    .replace("__CHUNK__", String(DETAIL_CHUNK));
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseCommon(sp) {
  const limitRaw = parseInt(sp.get("limit"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;

  const sortRaw = String(sp.get("sort") || "").trim().toLowerCase();
  const sort = ["price_asc", "price_desc", "stock_desc"].includes(sortRaw) ? sortRaw : "";

  const minExpiry = String(sp.get("min_expiry") || "").trim();
  if (minExpiry && !/^\d{4}-\d{2}(-\d{2})?$/.test(minExpiry)) {
    const e = new Error("min_expiry 格式应为 YYYY-MM 或 YYYY-MM-DD");
    e.status = 400;
    throw e;
  }

  return {
    limit,
    sort,
    in_stock: truthy(sp.get("in_stock")),
    min_expiry: minExpiry,
    nocache: truthy(sp.get("nocache")),
  };
}

function parsePriceRequest(input) {
  const sp = toSearchParams(input);
  const q = String(sp.get("q") || "").trim();
  if (!q) {
    const e = new Error("缺少查询词 q");
    e.status = 400;
    e.hint = "用法: GET /api/v1/qshtyy/price?q=化积口服液 或 POST {\"q\":\"化积口服液\"}";
    throw e;
  }
  return Object.assign({ q }, parseCommon(sp));
}

function parseBatchRequest(input) {
  const sp = toSearchParams(input);
  const raw = sp.getAll("qs").flatMap((v) => String(v).split(/[,，]/));
  const qs = raw.map((s) => String(s == null ? "" : s).trim()).filter(Boolean);
  if (!qs.length) {
    const e = new Error("缺少品种列表 qs");
    e.status = 400;
    e.hint = "用法: POST {\"qs\":[\"化积口服液\",\"藿香正气颗粒\"]} 或 GET ?qs=a,b(单次最多 10 个)";
    throw e;
  }
  if (qs.length > BATCH_MAX) {
    const e = new Error(`单次最多 ${BATCH_MAX} 个品种(收到 ${qs.length} 个)`);
    e.status = 400;
    throw e;
  }
  // 批量的公共参数(limit/sort/筛选)照常解析; q 由每个品种覆盖, 这里只填占位
  return { qs, base: Object.assign({ q: qs[0] }, parseCommon(sp)) };
}

function parseCompareRequest(input) {
  const sp = toSearchParams(input);
  const p = parsePriceRequest(input);
  const incl = String(sp.get("include_ysbang") == null ? "1" : sp.get("include_ysbang"));
  const pagesRaw = parseInt(sp.get("ysbang_pages"), 10);
  return Object.assign({}, p, {
    include_ysbang: truthy(incl),
    ysbang_mode: "cheapest",
    // 药师帮每个品种默认扫 3 页(约 180 条); 比价端点不追求穷尽, 只求量级可比
    ysbang_pages: Number.isFinite(pagesRaw) && pagesRaw > 0 ? Math.min(pagesRaw, 10) : 3,
  });
}

// ---------------------------------------------------------------------------
// 标签页定位: 优先复用用户已开的本站标签(0 额外请求), 没有再开后台标签
// ---------------------------------------------------------------------------
async function locateTab() {
  try {
    const data = await callTool("get_windows_and_tabs", {}, 15000);
    const obj = JSON.parse(dataText(data));
    for (const w of obj.windows || []) {
      for (const t of w.tabs || []) {
        if (t && t.url && String(t.url).indexOf(TAB_HOST) >= 0) {
          log("browser", `qshtyy reuse tab=${t.tabId} win=${t.windowId}`);
          // 复用的标签属于用户, 不关; keepOpen 同时让 needsHuman 时也保留
          return { tabId: t.tabId, windowId: t.windowId, keepOpen: true, reused: true };
        }
      }
    }
  } catch (e) {
    log("warn", `qshtyy locate tab failed (将新开标签): ${e.message}`);
  }
  const page = await openPage(TAB_URL, { siteMode: "tab" });
  page.reused = false;
  return page;
}

// ---------------------------------------------------------------------------
// 单页执行: 跑一次关键词, 处理错误分类
// ---------------------------------------------------------------------------
async function searchOnPage(page, p) {
  const raw = await jsEval(page.tabId, buildJs(p.q, p.limit), { strict: true, timeoutMs: 40000 });

  if (raw && (raw.error === "no_token" || raw.error === "unauthorized")) {
    // 登录态没了: 切前台让用户重新登录, 页面保留
    await needsHuman(page, "海豚药药登录态失效(token 缺失或已过期)");
  }
  if (raw && raw.error === "api_error") {
    const e = new Error(`海豚药药接口返回异常 code=${raw.code}${raw.message ? " " + raw.message : ""}(接口可能已变更)`);
    e.status = 502;
    e.hint = "本站点是内部 JSON 接口, 站点改版时会失效。核对 /api/goods/search/onCondition 与 /api/goods/goodsInfo/list 后更新 sites/qshtyy.js";
    throw e;
  }
  if (raw && raw.error) {
    throw new Error(`海豚药药请求失败: ${raw.message || raw.error}`);
  }
  if (!raw || !Array.isArray(raw.items)) {
    const e = new Error("海豚药药返回结构异常(缺少 items)");
    e.status = 502;
    throw e;
  }
  return raw;
}

function fin(v) {
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}

function mapItem(x) {
  const stock = fin(x.sq);
  const labels = String(x.lb || "").split(",").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  return {
    goods_id: x.i,
    name: x.n,
    spec: x.s || null,
    manufacturer: x.m || null,
    // price = sellingPrice = 当前登录账号可见的采购价(不是全网最低价, 也不是零售价)
    price: fin(x.p),
    retail_price: fin(x.rp),
    market_price: fin(x.mp),
    stock,
    in_stock: stock != null && stock > 0,
    expiry: x.e || null,
    moq: fin(x.mo),
    pack: fin(x.pk),
    piece: fin(x.pc),
    unit: x.u || null,
    approval: x.ap || null,
    insurance: x.ins || null,
    purchase_tag: x.tg || null,
    category: x.ct || null,
    labels,
  };
}

// 本地筛选与排序(该站搜索接口没有价格排序参数, columnType 是频道不是排序)
function refine(items, p) {
  let out = items;
  if (p.in_stock) out = out.filter((x) => x.in_stock);
  if (p.min_expiry) {
    out = out.filter((x) => x.expiry && String(x.expiry).slice(0, 10) >= p.min_expiry);
  }
  if (p.sort === "price_asc") {
    out = out.slice().sort((a, b) => (a.price == null ? Infinity : a.price) - (b.price == null ? Infinity : b.price));
  } else if (p.sort === "price_desc") {
    out = out.slice().sort((a, b) => (b.price == null ? -Infinity : b.price) - (a.price == null ? -Infinity : a.price));
  } else if (p.sort === "stock_desc") {
    out = out.slice().sort((a, b) => (b.stock == null ? -Infinity : b.stock) - (a.stock == null ? -Infinity : a.stock));
  }
  return out;
}

function buildPayload(p, raw, extra) {
  const items = refine(raw.items.map(mapItem), p);
  const prices = items.map((x) => x.price).filter((n) => n != null && n > 0);
  return Object.assign({
    source: "qshtyy(海豚药药 / 兰州强生) via web-to-openapi",
    fetched_at: new Date().toISOString(),
    query: p.q,
    total: raw.total == null ? items.length : raw.total,
    count: items.length,
    truncated: (raw.total || 0) > raw.items.length,
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    price_note: "price 为当前登录账号可见的采购价(sellingPrice); retail_price 为零售价, market_price 为市场价(可能为 0)",
    items,
  }, extra || {});
}

// ---------------------------------------------------------------------------
// 主流程: 单品种
// ---------------------------------------------------------------------------
async function searchOne(p, opts) {
  const o = opts || {};
  const key = cacheKey(p);
  if (!p.nocache) {
    const hit = cacheGet(key);
    if (hit) {
      return Object.assign({}, hit.payload, {
        cached: true,
        cache_age_s: Math.round((Date.now() - hit.at) / 1000),
      });
    }
  }

  const ownPage = !o.page;
  const page = o.page || (await locateTab());
  try {
    const raw = await searchOnPage(page, p);
    const payload = buildPayload(p, raw, { cached: false, reused_tab: !!page.reused });
    cachePut(key, payload);
    return payload;
  } finally {
    if (ownPage) await closePage(page);
  }
}

// ---------------------------------------------------------------------------
// 批量: 一个标签内顺序跑, 词间留间隔(总请求 = 品种数 × 2), 单品种失败不影响其他
// ---------------------------------------------------------------------------
async function searchBatch(qs, base) {
  const page = await locateTab();
  const results = [];
  let aborted = false;
  try {
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (i && !aborted) await sleep(400 + Math.floor(Math.random() * 400));
      try {
        const data = await searchOne(Object.assign({}, base, { q }), { page });
        results.push({ q, ok: true, data });
      } catch (e) {
        results.push({ q, ok: false, error: e.message });
        // 登录失效/被拦这类问题是全局的, 立即停手, 别把剩下的词全撞一遍
        if (e.needs_human || (e.status === 502 && /登录/.test(e.message))) aborted = true;
      }
    }
  } finally {
    await closePage(page);
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    source: "qshtyy(海豚药药 / 兰州强生) via web-to-openapi",
    fetched_at: new Date().toISOString(),
    requested: qs.length,
    ok_count: okCount,
    failed_count: results.length - okCount,
    aborted,
    results,
  };
}

// ---------------------------------------------------------------------------
// 跨平台比价: 海豚药药(单一供货方/多厂家多规格) vs 药师帮(多供应商)
// 两个平台口径不同, 只给「量级对比 + 宽松同规格匹配」, 不做等号式结论
// ---------------------------------------------------------------------------
function specTokens(s) {
  const t = String(s || "").toLowerCase().replace(/[×xX＊]/g, "*").replace(/\s+/g, "");
  const m = t.match(/\d+(?:\.\d+)?(?:ml|mg|g|片|粒|袋|支|丸|贴|只|包|瓶|抽|克)/g);
  return m ? Array.from(new Set(m)) : [];
}

function hasToken(hay, token) {
  const h = String(hay || "").toLowerCase().replace(/[×xX＊]/g, "*").replace(/\s+/g, "");
  const re = new RegExp("(^|[^0-9.])" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return re.test(h);
}

function monthsAhead(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

// 药品通用名词: 用来识别「药师帮字体反爬残留的乱码品名」(整串生僻字, 一个通用词都命中不了)
const DRUG_WORD_RE = /口服液|胶囊|颗粒|片剂|片|丸|膏|贴|栓|散|滴|喷|糖浆|洗剂|凝胶|软膏|眼药|剂|素|酸|钠|钾|锌|钙|维生素|霉素|沙星|洛尔|地平|单抗|唑|芬|胺/;
const PRESALE_RE = /预约|预售|订货|定金/;

/*
 * 药师帮条目的「可比性」标注。
 * 为什么必须做: 实测 2026-11-14 化积口服液, 药师帮全场最低 0.50 元来自
 * 「药店品种预约中心」, 效期 2026-12-31(一个多月后就过期) —— 与海豚药药那边
 * 效期 2028 的正价货不是同一种东西, 直接相除会得出「便宜 1496%」的荒谬结论。
 * 同批还有两条品名是纯乱码(字体反爬残留), 价格可信但品名不可信。
 */
function prepareYsbangItem(x) {
  const name = String(x.name || "");
  const shop = String(x.shop || x.warehouse || "");
  const expiry = String(x.expiry || "");
  return {
    name,
    factory: x.factory || null,
    shop: shop || null,
    price: fin(x.price),
    moq: x.moq || null,
    expiry: expiry || null,
    // 品名乱码: 药材通用词一个都没有, 且长度够长(短品牌名不判)
    name_garbled: name.length >= 8 && !DRUG_WORD_RE.test(name),
    // 效期不足 6 个月: 临期清仓价, 不能与正价货混比
    short_expiry: !!expiry && expiry.slice(0, 10) < monthsAhead(6),
    presale: PRESALE_RE.test(shop),
  };
}

function pickLowest(arr) {
  return arr.length ? arr.reduce((a, b) => (b.price < a.price ? b : a)) : null;
}

/*
 * 品名基础名比对。
 * 实测教训: 「化积口服液」(药品) 与「消食化积口服液」(川奇保健品) 规格都是 10ml*6支,
 * 只按规格匹配会把两个不同品种并排, 看起来像「同一盒药便宜了 2.95 元」。
 * 返回 "" = 品名完全一致; 非空 = 多出的修饰词(如「消食」, 很可能是不同品种); null = 不含基础名。
 */
function nameExtraOf(baseName, candName) {
  const base = String(baseName || "").replace(/[（(][^）)]*[)）]/g, "").trim();
  if (!base) return null;
  const cand = String(candName || "");
  const idx = cand.indexOf(base);
  if (idx < 0) return null;
  const m = cand.slice(0, idx).match(/[\u4e00-\u9fa5]+$/);
  return m ? m[0] : "";
}

/*
 * 厂家名归一: 不同厂家的货不能比价。
 * 「恩威(江西)制药有限公司」/「恩威（江西）制药有限公司」/「恩威」应视为同一家;
 * 「江西诚志永丰药业有限责任公司」与「恩威」必须区分开。
 */
function mfKey(s) {
  return String(s || "")
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/有限责任公司|有限公司|股份|集团|制药|药业|医药|生物|科技|实业|总厂|公司|厂/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function diffOf(a, b) {
  if (!a || !b || !(a.price > 0) || !(b.price > 0)) return null;
  const abs = Number((a.price - b.price).toFixed(2));
  return {
    abs,
    pct: Number(((abs / b.price) * 100).toFixed(2)),
    cheaper: abs < 0 ? "qshtyy" : abs > 0 ? "ysbang" : "tie",
  };
}

function slimItem(x) {
  if (!x) return null;
  return {
    name: x.name,
    spec: x.spec || null,
    manufacturer: x.manufacturer || x.factory || null,
    shop: x.shop || null,
    price: x.price,
    stock: x.stock == null ? undefined : x.stock,
    expiry: x.expiry || null,
    flags: x.name_garbled || x.short_expiry || x.presale
      ? { name_garbled: !!x.name_garbled, short_expiry: !!x.short_expiry, presale: !!x.presale }
      : undefined,
    // 品名多出的修饰词(如「消食」): 出现即代表很可能是不同品种, 不能当同一盒药比
    extra_words: x.name_extra ? x.name_extra : undefined,
  };
}

async function comparePrices(p) {
  const started = Date.now();
  const tasks = [
    searchOne(p, {})
      .then((d) => ({ ok: true, data: d }))
      .catch((e) => ({ ok: false, error: e.message, needs_human: !!e.needs_human, hint: e.hint })),
  ];

  if (p.include_ysbang) {
    const tool = registry.findTool("ysbang_price");
    if (!tool) {
      tasks.push(Promise.resolve({ ok: false, error: "ysbang_price 工具未注册" }));
    } else {
      tasks.push(
        withBrowserSlot("ysbang", 3, () =>
          tool.run({ q: p.q, mode: p.ysbang_mode, pages: p.ysbang_pages, top: 30 })
        )
          .then((d) => ({ ok: true, data: d }))
          .catch((e) => ({ ok: false, error: e.message, hint: e.hint }))
      );
    }
  } else {
    tasks.push(Promise.resolve({ ok: false, skipped: true, error: "include_ysbang=false, 未查询药师帮" }));
  }

  const [qt, yb] = await Promise.all(tasks);

  const qtAll = (qt.ok && qt.data.items ? qt.data.items : []).filter((x) => x.price != null && x.price > 0);
  const ybAll = (yb.ok && yb.data.items ? yb.data.items : [])
    .map(prepareYsbangItem)
    .filter((x) => x.price != null && x.price > 0)
    // 以用户查询词为基础名标注品名差异(化积口服液 / 消食化积口服液)
    .map((x) => Object.assign(x, { name_extra: nameExtraOf(p.q, x.name) }));

  /*
   * 是否启用「品名基础名」过滤:
   * 查询词在药师帮里若根本不出现(拼音、俗称、厂家名), 强行过滤会把结果清零,
   * 所以要求至少 20%(且不少于 3 条)命中基础名才启用, 否则退回不按品名筛。
   */
  const namedCount = ybAll.filter((x) => x.name_extra !== null).length;
  const useNameFilter = namedCount >= Math.max(1, Math.min(3, Math.ceil(ybAll.length * 0.2))) && namedCount > 0;

  // 全场最低(原语义): 含临期/预约/乱码条目, 只作「存在这个价」的证据
  const qtLow = pickLowest(qtAll);
  const ybLow = pickLowest(ybAll);
  const diff = diffOf(qtLow, ybLow);

  // 同口径最低: 排除临期(效期<6个月)、预约锁货、品名乱码 —— 这才是能直接用的数字
  const qtFair = qtAll.filter((x) => !(x.expiry && String(x.expiry).slice(0, 10) < monthsAhead(6)));
  const ybFair = ybAll.filter(
    (x) => !x.name_garbled && !x.presale && !x.short_expiry && (!useNameFilter || x.name_extra !== null)
  );
  const qtLowFair = pickLowest(qtFair);
  const ybLowFair = pickLowest(ybFair);
  const fairDiff = diffOf(qtLowFair, ybLowFair);
  // 品名完全一致的那批里的最低价: 最严格的「同一盒药」对比
  const ybStrict = ybFair.filter((x) => x.name_extra === "");
  const ybLowStrict = pickLowest(ybStrict);

  // 同厂家对比: 拿 A 厂的价去压 B 厂没有意义, 这是能不能直接谈价的关键一层
  const qtMf = mfKey(qtLowFair && qtLowFair.manufacturer);
  const ybSameMf = qtMf
    ? ybFair.filter((x) => {
        const k = mfKey(x.factory);
        return !!k && (k.indexOf(qtMf) >= 0 || qtMf.indexOf(k) >= 0);
      })
    : [];
  const ybLowSameMf = pickLowest(ybSameMf);

  // 同规格匹配(以海豚药药最低价条目的规格为基准), 只对同口径条目做
  let ybMatches = [];
  if (qtLow && ybFair.length) {
    const toks = specTokens(qtLow.spec);
    if (toks.length) {
      ybMatches = ybFair
        .filter((x) => toks.every((t) => hasToken(x.name, t)))
        .sort((a, b) => a.price - b.price)
        .slice(0, 5)
        .map(slimItem);
    }
  }

  const anyFlagged = (ybLow && (ybLow.name_garbled || ybLow.short_expiry || ybLow.presale)) || false;
  const plausibility = (() => {
    if (!diff) return null;
    if (anyFlagged) return { plausible: false, reason: "ysbang_lowest_flagged", hint: "药师帮最低价条目带 flags(临期/预约/乱码), 请看 fair 节点" };
    if (Math.abs(diff.pct) > 200) return { plausible: false, reason: "gap_too_large", hint: "两边最低价相差超过 200%, 极可能是不同规格/临期/促销折算价, 需人工核对" };
    return { plausible: true, reason: "ok" };
  })();

  return {
    source: "compare(qshtyy vs ysbang) via web-to-openapi",
    fetched_at: new Date().toISOString(),
    query: p.q,
    elapsed_ms: Date.now() - started,
    qshtyy: qt.ok
      ? {
          ok: true,
          count: qt.data.count,
          total: qt.data.total,
          price_min: qt.data.price_min,
          price_max: qt.data.price_max,
          lowest: slimItem(qtLow),
          items: (qt.data.items || []).slice(0, 10),
        }
      : { ok: false, error: qt.error, needs_human: qt.needs_human, hint: qt.hint },
    ysbang: yb.skipped
      ? { ok: false, skipped: true, reason: yb.error }
      : yb.ok
        ? {
            ok: true,
            count: yb.data.count,
            price_min: yb.data.price_min,
            price_max: yb.data.price_max,
            pages_scanned: yb.data.pages_fetched,
            complete: yb.data.complete,
            lowest: slimItem(ybLow),
            items: ybAll.slice(0, 10).map(slimItem),
          }
        : { ok: false, error: yb.error, hint: yb.hint },
    // 全场最低价对比: 只说明「存在这个价」, 不保证可比
    diff: diff ? Object.assign(diff, { plausibility }) : null,
    // 同口径对比: 排除临期/预约/乱码后, 才是能拿去谈价的数字
    fair: {
      basis:
        "同口径: 两边都排除效期不足 6 个月的临期货; 药师帮再排除预约/预售店铺与品名乱码条目" +
        (useNameFilter ? ", 且只保留品名含查询词的条目(避免「消食化积口服液」混进「化积口服液」)" : ""),
      qshtyy: { count: qtFair.length, lowest: slimItem(qtLowFair) },
      ysbang: {
        count: ybFair.length,
        lowest: slimItem(ybLowFair),
        // 品名完全一致(无多余修饰词)里的最低价, 最严格的同品种对比
        lowest_strict: slimItem(ybLowStrict),
        name_filtered: useNameFilter,
        // 海豚药药最低价那个厂家的货, 在药师帮里的最低价(同厂家才有可比性)
        same_manufacturer: { key: qtMf || null, count: ybSameMf.length, lowest: slimItem(ybLowSameMf) },
        manufacturer_mismatch: !!(ybLowFair && qtLowFair && !(ybLowSameMf && ybLowSameMf === ybLowFair)),
      },
      diff: fairDiff,
      diff_strict: diffOf(qtLowFair, ybLowStrict),
      diff_same_manufacturer: diffOf(qtLowFair, ybLowSameMf),
      excluded: { qshtyy: qtAll.length - qtFair.length, ysbang: ybAll.length - ybFair.length },
    },
    same_spec_matches: ybMatches,
    caveat:
      "口径不同, 不要直接拿 diff 下结论: ① 海豚药药是单一供货方(兰州强生)对同一品种的多厂家多规格报价, price 是你账号的采购价; " +
      "② 药师帮是多供应商挂牌批发价, 最低价常来自临期清仓、预约锁货或不同规格; ③ 优先看 fair 节点(已排除临期/预约/乱码), " +
      "diff 只说明「场上存在这个价」; ④ same_spec_matches 是按品名里规格片段(如 10ml/12支)的宽松匹配, 仍需人工核对。",
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
module.exports = {
  id: "qshtyy",
  title: "海豚药药(兰州强生)报价",
  // 单站点单槽: 同一次调用内只用一个标签, 不同调用之间排队
  concurrency: 1,
  // 测试与 compare 复用
  _internal: {
    searchOne, searchBatch, comparePrices, parsePriceRequest, parseCompareRequest,
    buildJs, prepareYsbangItem, diffOf, pickLowest, monthsAhead, nameExtraOf, mfKey, cache, CACHE_TTL_MS,
  },
  endpoints: [
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/qshtyy/price",
      tool: "qshtyy_price",
      operationId: "qshtyyPrice",
      summary: "海豚药药(兰州强生)报价查询 —— 接口直连, 价格/库存/效期全字段",
      description:
        "驱动浏览器在你已登录的海豚药药极速版(pc.qshtyy.com, 兰州强生医药)上按关键词查采购报价。" +
        "走站内 JSON 接口(/api/goods/search/onCondition + /api/goods/goodsInfo/list), 无字体反爬, 单品种约 1~2 秒。" +
        "返回每个厂家的 sellingPrice(你的采购价)、零售价、市场价、库存、效期、起订量、中包装/件装、批准文号、医保分类、采购标签。采集后按 5 分钟内存缓存复用。",
      post: {
        operationId: "qshtyyPricePost",
        summary: "海豚药药报价(POST JSON body, 中文免 URL 编码)",
        description: "与 GET 参数相同, 改用 JSON body。中文关键词推荐用本方式。",
      },
      example: { q: "化积口服液", limit: 100 },
      responses: {
        200: { description: "报价列表(total/count/price_min/price_max/items)" },
        400: { description: "缺少查询词 q 或 min_expiry 格式错误" },
        502: { description: "站点接口返回异常(可能已改版)" },
        503: { description: "需要人工登录(needs_human=true)" },
      },
      browser: true,
      parse: parsePriceRequest,
      run: (p) => searchOne(p, {}),
      doc: {
        note:
          "海豚药药(兰州强生)报价。复用浏览器里的登录态, 走站内接口, 单品种约 1~2 秒。price 是你账号的采购价, 不是全网最低价; 该站是单一供货方, 同一品种会返回多个厂家/规格。宽词(如“片”命中 2730 条)用 limit 截断, truncated=true 表示没取完。",
        tryQuery: "/api/v1/qshtyy/price?q=化积口服液",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/qshtyy/price?q=%E5%8C%96%E7%A7%AF%E5%8F%A3%E6%9C%8D%E6%B6%B2"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/qshtyy/price \\
  -H "Content-Type: application/json" \\
  -d '{"q":"化积口服液","limit":100}'`,
        postNote: "中文关键词推荐 POST, body 里的中文不需要 URL 编码。",
      },
    },
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/qshtyy/batch",
      tool: "qshtyy_batch_price",
      operationId: "qshtyyBatchPrice",
      summary: "海豚药药批量询价(一个标签跑多个品种, 单次最多 10 个)",
      description:
        "一次请求查多个品种。复用同一个标签页顺序执行, 词间留 400~800ms 间隔, 总请求量 = 品种数 × 2。" +
        "单品种失败不影响其他品种; 遇到登录失效立即停手(aborted=true)。其余参数与单条查询一致。",
      post: {
        operationId: "qshtyyBatchPricePost",
        summary: "海豚药药批量询价(POST JSON body)",
        description: "body 形如 {\"qs\":[\"化积口服液\",\"藿香正气颗粒\"],\"limit\":100}。",
      },
      example: { qs: ["化积口服液", "藿香正气颗粒"], limit: 50 },
      responses: {
        200: { description: "按入参顺序返回 results[{q,ok,data|error}], 带 ok_count/failed_count/aborted" },
        400: { description: "缺少 qs 或超过 10 个品种" },
      },
      browser: true,
      parse: parseBatchRequest,
      run: (args) => searchBatch(args.qs, args.base),
      doc: {
        note: "批量询价: 一个标签内顺序跑, 单次上限 10 个品种。登录失效会整体停手, 已完成结果照常返回。",
        tryQuery: "/api/v1/qshtyy/batch?qs=化积口服液,藿香正气颗粒",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/qshtyy/batch?qs=%E5%8C%96%E7%A7%AF%E5%8F%A3%E6%9C%8D%E6%B6%B2,%E8%97%BF%E9%A6%99%E6%AD%A3%E6%B0%94%E9%A2%97%E7%B2%92"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/qshtyy/batch \\
  -H "Content-Type: application/json" \\
  -d '{"qs":["化积口服液","藿香正气颗粒"],"limit":50}'`,
        postNote: "多个品种推荐 POST 传数组, 中文无需编码。",
      },
    },
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/compare/price",
      tool: "price_compare",
      operationId: "priceCompare",
      summary: "跨平台并排比价: 海豚药药(兰州强生) vs 药师帮",
      description:
        "同一个关键词同时查海豚药药与药师帮, 并排返回两边的最低价、条数与样品条目。两个平台并行执行(各自一个标签), 海豚药药约 1~2 秒, 药师帮约 12~18 秒。" +
        "响应分两层: diff = 全场最低价对比(只说明场上存在这个价), fair = 同口径对比(两边都排除效期不足 6 个月的临期货, 药师帮再排除预约/预售店铺与品名乱码条目)。" +
        "⚠ 药师帮最低价经常来自临期清仓或预约锁货(实测 0.50 元的化积口服液效期只剩一个多月), 直接比对会得出「便宜 15 倍」的荒谬结论 —— 请优先看 fair.diff。",
      post: {
        operationId: "priceComparePost",
        summary: "跨平台比价(POST JSON body)",
        description: "body 形如 {\"q\":\"化积口服液\",\"include_ysbang\":true,\"ysbang_pages\":3}。",
      },
      example: { q: "化积口服液", include_ysbang: true, ysbang_pages: 3 },
      responses: {
        200: { description: "两边结果 + diff + caveat" },
        400: { description: "缺少查询词 q" },
        503: { description: "哪个平台需要人工登录会标在对应节点上" },
      },
      browser: true,
      parse: parseCompareRequest,
      run: (p) => comparePrices(p),
      doc: {
        note:
          "跨平台并排比价。两边并行跑, 药师帮较慢(约 12~18 秒)。看 fair.diff(同口径)而不是 diff(全场最低): 药师帮最低价常来自临期清仓或预约锁货, 实测 0.50 元的化积口服液效期只剩一个多月, 与海豚药药效期 2028 的正价货不是同一种东西。fair 会排除临期(<6 个月)、预约店铺和品名乱码条目。same_spec_matches 是按品名里规格片段的宽松匹配, 仍需人工核对。",
        tryQuery: "/api/v1/compare/price?q=化积口服液",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/compare/price?q=%E5%8C%96%E7%A7%AF%E5%8F%A3%E6%9C%8D%E6%B6%B2"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/compare/price \\
  -H "Content-Type: application/json" \\
  -d '{"q":"化积口服液","include_ysbang":true,"ysbang_pages":3}'`,
        postNote: "include_ysbang=false 可只查海豚药药(快), 稍后再补药师帮。",
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "qshtyy_price",
      description:
        "海豚药药极速版(pc.qshtyy.com, 兰州强生医药)B2B 采购报价查询, 复用浏览器已登录账号, 走站内 JSON 接口, 单品种约 1~2 秒(远快于药师帮)。" +
        "返回每条的 price(你账号的采购价 sellingPrice)、retail_price、market_price、stock、expiry、moq(起订)、pack(中包装)、piece(件装)、approval(批准文号)、insurance(医保)、purchase_tag(采购标签)。" +
        "关键词支持品名/厂家/拼音首字母。结果按 5 分钟内存缓存复用(nocache=true 强制重采)。宽词用 limit 截断并标 truncated。",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "搜索关键词(品名/厂家/拼音首字母), 如 化积口服液" },
          limit: { type: "integer", minimum: 1, maximum: 300, description: "最多返回多少条明细(默认 100); 宽词如“片”命中 2730 条, 超出的不取并标 truncated" },
          sort: { type: "string", enum: ["price_asc", "price_desc", "stock_desc"], description: "本地排序(该站搜索接口没有价格排序参数): 价格升/降序、库存降序" },
          in_stock: { type: "boolean", description: "只保留库存 > 0 的条目(默认 false)" },
          min_expiry: { type: "string", description: "只要效期不早于该月(YYYY-MM 或 YYYY-MM-DD), 如 2028-06" },
          nocache: { type: "boolean", description: "true=跳过 5 分钟缓存强制重新采集" },
        },
        required: ["q"],
      },
      browser: true,
      run: (args) => searchOne(parsePriceRequest(args || {}), {}),
    },
    {
      name: "qshtyy_batch_price",
      description:
        "海豚药药批量询价: 一次查多个品种(qs, 单次最多 10 个), 复用同一个标签页顺序跑, 词间留 400~800ms 间隔。" +
        "按入参顺序返回 results[{q,ok,data|error}], 单品种失败不影响其他品种; 登录失效会立即停手(aborted=true)。" +
        "其余参数与 qshtyy_price 相同。比价多个品种时优先用它, 省去反复开关标签页。",
      inputSchema: {
        type: "object",
        properties: {
          qs: { type: "array", items: { type: "string" }, description: "品种关键词数组, 如 [\"化积口服液\",\"藿香正气颗粒\"]; 也接受逗号分隔字符串。单次最多 10 个" },
          limit: { type: "integer", minimum: 1, maximum: 300, description: "每个品种最多返回多少条(默认 100)" },
          sort: { type: "string", enum: ["price_asc", "price_desc", "stock_desc"], description: "每个品种结果本地排序" },
          in_stock: { type: "boolean", description: "只保留有库存的条目" },
          min_expiry: { type: "string", description: "只要效期不早于该月(YYYY-MM)" },
          nocache: { type: "boolean", description: "true=跳过缓存强制重新采集" },
        },
        required: ["qs"],
      },
      browser: true,
      run: (args) => {
        const { qs, base } = parseBatchRequest(args || {});
        return searchBatch(qs, base);
      },
    },
    {
      name: "price_compare",
      description:
        "跨平台并排比价: 同一个关键词同时查海豚药药(兰州强生)与药师帮, 两边并行执行。" +
        "返回 qshtyy / ysbang 各自的 ok/count/price_min/price_max/lowest/items。" +
        "关键看 fair 节点: fair.diff 是同口径对比(两边排除效期<6个月的临期货, 药师帮再排除预约/预售店铺与品名乱码条目), 这才是能拿去谈价的数字; " +
        "diff 是全场最低价对比, 只说明「场上存在这个价」—— 药师帮最低价常来自临期清仓, 实测 0.50 元的化积口服液效期只剩一个多月, 直接比会得出「便宜 15 倍」的荒谬结论。" +
        "same_spec_matches 按品名里的规格片段(如 10ml、12支)做宽松匹配, 仍需人工核对。include_ysbang=false 可只查海豚药药(约 1~2 秒); 默认两边都查, 以药师帮较慢(12~18 秒)为准。",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "搜索关键词, 两个平台用同一个词" },
          limit: { type: "integer", minimum: 1, maximum: 300, description: "海豚药药返回条数上限(默认 100)" },
          in_stock: { type: "boolean", description: "海豚药药侧只保留有库存的条目" },
          include_ysbang: { type: "boolean", description: "是否同时查药师帮(默认 true); false 时只查海豚药药, 秒回" },
          ysbang_pages: { type: "integer", minimum: 1, maximum: 10, description: "药师帮扫描页数(默认 3, 约 180 条), 页数越多最低价越准也越慢" },
        },
        required: ["q"],
      },
      browser: true,
      run: (args) => comparePrices(parseCompareRequest(args || {})),
    },
  ],
};
