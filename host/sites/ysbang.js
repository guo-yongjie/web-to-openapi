"use strict";
/*
 * 站点: 药师帮(https://dian.ysbang.cn) 批发报价
 * ---------------------------------------------------------------------------
 * 这是本项目第一个「需要破解反爬」的站点, 但 host 侧不做任何破解:
 *   - 接口层 getWholesaleList 返回 AES 密文 -> 不直接调, 在页面内挂钩 JSON.parse
 *     取「前端解密后的明文对象」(v1.2.0 起的主力路径, sites/ysbang-hook.js)
 *   - 字体层价格用 ysb-din-bold + 连字渲染, DOM 文本是乱码汉字
 *     -> 挂钩不可用时兜底: sites/ysbang-decode.js 在页面内用 canvas 做字形指纹匹配
 *
 * 挂钩为什么要「先装后触发」: 挂钩必须在列表请求之前装好, 而导航会重载文档把
 * 挂钩清掉。所以流程是: 导航到搜索页 -> 装挂钩 -> 翻到第 2 页再翻回第 1 页
 * (这两次翻页让接口在挂钩就位后重新请求) -> 之后每页都直接读捕获。
 *
 * 翻页的坑(实测):
 *   chrome_navigate 对同站点会「复用已有标签且不更新 URL」(复用判断发生在
 *   newWindow 之前), 而本页是 hash 路由的 SPA —— 直接改 hash 又会被路由规范化
 *   回原页码。所以翻页只能走页面自己的分页控件(.pagination-prev/.pagination-next),
 *   并以 hash 里的 page 变化作为完成信号。
 *
 * 复用标签的副作用: 若用户原本就开着药师帮, 会就地切换他的搜索词。
 * 因此结束时不关闭复用的标签(只关自己新开的), 并在响应里标 reused_tab=true。
 *
 * v1.5.0 并发能力(对照 Tencent/BrowserSkill 的 per-session queue 设计):
 *   tabs=2~3      页级并发: 第 1 页留在协调标签, 其余页各开一个标签直达 page=N,
 *                 把「翻页串行等待」压缩成并发加载。仅 names=font 时生效。
 *   /batch        批量询价: 多品种 × 2 标签并发, 一次问完 5~10 个品种。
 *   两者都受同一把页级节流闸(pagePacer)约束, 标签数增加不等于请求速率增加。
 */
const fs = require("fs");
const path = require("path");
const {
  openPage, closePage, jsEval, extractSerp, needsHuman, sleep,
  callTool, dataText, toSearchParams, createPacer,
} = require("../lib/util");
const { log } = require("../lib/log");
// v1.6.0: 缓存/熔断状态逻辑拆到 ysbang-store.js(纯状态, 不依赖浏览器), 并新增落盘持久化
const {
  DEFAULT_TTL_S, cacheGet, cachePut, assertNotBlocked, markBlocked, blockError, stats: storeStats,
} = require("./ysbang-store");

const DECODE_JS = fs.readFileSync(path.join(__dirname, "ysbang-decode.js"), "utf8");
const HOOK_JS = fs.readFileSync(path.join(__dirname, "ysbang-hook.js"), "utf8");

// 页面内挂钩脚本按模式注入(MODE 是页面脚本里的常量声明, 只能文本替换)
// ⚠ 必须全局替换: 占位符在文件头注释里也出现一次, 用 String.replace 只会换掉注释那处
function hookJs(mode) {
  return HOOK_JS.split("__YSB_MODE__").join(mode);
}

const SITE = "https://dian.ysbang.cn/";
const ROUTE = "#/indexContent";
const DEFAULT_PAGESIZE = 60;
const MAX_PAGES = 20;

/*
 * 抗风控四件套(v1.4.0: 三件套 + 节奏拟人化)
 * ---------------------------------------------------------------------------
 * 触发拦截的真实原因不是指纹伪装不足, 而是「请求形态不像人」:
 * 一次比价原本要 1 次搜索 + 13 次翻页 = 14 次请求, 间隔整齐地挤在 70 秒内。
 * 所以对齐手段也放在请求侧:
 *   1) 缓存      —— 同词同参数在 TTL 内直接复用, 重复查询 0 请求(v1.6.0 起落盘, 重启不丢)
 *   2) cheapest  —— 只要最低价时走「第 1 页 + 价格升序」, 2 次请求就能拿到
 *   3) 熔断      —— 一旦探测到滑块/验证码立即停手并冷却, 绝不在被拦后继续撞
 *                    (v1.6.0 起冷却状态也落盘, host 随浏览器重启不会绕过冷却)
 *   4) 拟人节奏  —— 随机延时 + 走入框打字搜索 + 浏览滚动 + 偶发长停顿
 *                    (v1.4.0 新增; 固定节奏连跑 ~35 次即被网关成片 504, 见实测)
 * 熔断冷却期内所有请求快速失败(不打页面), 保护的是浏览器里那个真实采购账号。
 * 缓存与熔断的实现/持久化见 ysbang-store.js; 运行观测经 GET /stats 读。
 */
// 页面级网络请求计数器(导航/翻页/切排序)。仅作度量用: 并发调用时数值可能互相叠加,
// 不影响功能; 想精确对比抗风控效果时串行调用即可。
let reqCounter = 0;

// 轻量状态探针: 只回页码/条数/是否需登录/是否已是目标关键词, 不含任何 URL 或查询串。
// __YSB_Q__ 在运行时替换为 JSON 字符串(目标关键词), 用于识别「已导航但列表还是旧数据」的窗口。
const STAT_JS_TPL = `
const Q = __YSB_Q__;
const cards = document.querySelectorAll(".all-goods-wrapper");
const m = (location.hash || "").match(/[?&]page=(\\d+)/);
const body = document.body.innerText || "";
const t = body.match(/共\\s*([\\d,]+)\\s*条/);
let h = "";
try { h = decodeURIComponent(location.hash || ""); } catch (e) { h = ""; }
// 首条卡片内容指纹(纯数字), 用于判断翻页后列表是否真的换了一批
let fh = 0;
if (cards[0]) {
  const s0 = cards[0].innerText || "";
  for (let i = 0; i < Math.min(s0.length, 200); i++) fh = (fh * 31 + s0.charCodeAt(i)) % 100000007;
}
// 风控拦截探测: 滑块/图形验证码容器 + 提示文案。命中即视为被拦, host 侧立刻熔断。
// ⚠ 必须判「可见」: 药师帮页面里常驻一个隐藏的验证组件(display:none),
//    只看 DOM 存在会把每一页都误判成被拦(实测踩过, 导致首屏即熔断)。
const VC_SEL = 'iframe[src*="captcha"],iframe[src*="verify"],[class*="yidun"],[class*="geetest"],.nc_container,.nc_scale,.verify-wrap,[id*="captcha"],[class*="slider-verify"]';
let vcDom = false;
try {
  const vcEls = document.querySelectorAll(VC_SEL);
  for (let i = 0; i < vcEls.length; i++) {
    const el = vcEls[i];
    const rc = el.getBoundingClientRect();
    if (rc.width < 20 || rc.height < 20) continue; // 无尺寸 = 未渲染
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
    vcDom = true;
    break;
  }
} catch (e) { vcDom = false; }
const vcText = /拖动滑块|请完成验证|完成验证后继续|访问过于频繁|操作过于频繁|操作异常|安全验证|人机验证/.test(body.slice(0, 4000));
return {
  qok: Q ? h.indexOf("searchkey=" + Q) >= 0 : true,
  page: m ? +m[1] : null,
  n: cards.length,
  fh: fh,
  total: t ? +String(t[1]).replace(/,/g, "") : null,
  ready: document.readyState,
  hasList: cards.length > 0,
  bodyLen: body.length,
  vcode: vcDom || vcText,
  needLogin: /请先登录|登录后查看|登录已失效/.test(body.slice(0, 3000))
};
`;

function statJs(q) {
  return STAT_JS_TPL.replace("__YSB_Q__", JSON.stringify(String(q || "")));
}

function buildUrl(q, page, pagesize) {
  const hash = `${ROUTE}?searchkey=${encodeURIComponent(q)}&page=${page || 1}&pagesize=${pagesize || DEFAULT_PAGESIZE}`;
  return SITE + hash;
}

function parseRequest(input) {
  const sp = toSearchParams(input);
  const q = String(sp.get("q") || "").trim();
  if (!q) {
    const e = new Error("缺少查询词 q");
    e.status = 400;
    e.hint = "用法: GET /api/v1/ysbang/price?q=化积口服液 或 POST {\"q\":\"化积口服液\"}";
    throw e;
  }
  const pagesRaw = parseInt(sp.get("pages"), 10);
  let pages = Number.isFinite(pagesRaw) && pagesRaw > 0 ? Math.min(pagesRaw, MAX_PAGES) : 0; // 0=不限
  const sort = String(sp.get("sort") || "").trim().toLowerCase();

  /*
   * mode:
   *   full(默认)   原行为, 按 pages 翻页全量采集
   *   cheapest     比价专用: 默认只扫前 3 页(约 180 条), 按价格升序后取前 top 条
   *                返回里 complete/lowest_is_global 标明是否已扫完全部结果
   * ⚠ 实测(2026-10-23): 药师帮搜索页没有价格排序项(排序栏只有 默认排序/月销店数/销量),
   *    pagesize 也固定约 60 条 —— 所以「只取最低价」无法用排序一步拿到, 只能限制扫描页数。
   */
  const mode = /^cheapest$/i.test(String(sp.get("mode") || "")) ? "cheapest" : "full";
  if (mode === "cheapest" && !pages) pages = 3;

  const topRaw = parseInt(sp.get("top"), 10);
  const top = Number.isFinite(topRaw) && topRaw > 0 ? Math.min(topRaw, 30) : 8;

  const ttlRaw = parseInt(sp.get("ttl"), 10);
  // ttl=0 关闭缓存; 不传走默认 12h
  const ttl = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? Math.min(ttlRaw, 7 * 24 * 3600) : DEFAULT_TTL_S;

  /*
   * tabs(v1.5.0): 本次查询最多并行开几个标签做「页级并发」。
   *   1(默认)= 老行为, 单标签顺序翻页;
   *   2~3    = 第 1 页留在协调标签, 其余页各开一个标签直达 page=N。
   * 只在 names=font(默认)时生效: 挂钩模式每页要额外预热一次请求, 并发等于把
   * 请求数翻倍, 与抗风控目标相反 —— 传了也会被忽略并记日志。
   * 标签数不等于请求速率: 所有请求仍过同一把页级节流闸(pagePacer)。
   */
  const tabsRaw = parseInt(sp.get("tabs"), 10);
  const tabsGiven = sp.get("tabs") != null && Number.isFinite(tabsRaw);
  const tabs = tabsGiven && tabsRaw > 0 ? Math.min(tabsRaw, MAX_TABS) : 1;

  return {
    q,
    mode,
    pages,
    pagesize: DEFAULT_PAGESIZE,
    top,
    ttl,
    tabs,
    tabs_given: tabsGiven, // 批量询价要靠它区分「没传」和「显式要串行」
    nocache: /^(1|true|yes)$/i.test(String(sp.get("nocache") || "")),
    reset_block: /^(1|true|yes)$/i.test(String(sp.get("reset_block") || "")),
    sort: ["price_asc", "price_desc"].includes(sort) ? sort : "",
    include_zero: /^(1|true|yes)$/i.test(String(sp.get("include_zero") || "")),
    // names=font(默认): 只走字体解码, 与 v1.1.0 同速(实测 3 页约 18s), 品名有 ~3-5% 促销项乱码
    // names=hook: 每页多一次页面内提取, 用解密明文覆盖品名/厂家/商家(实测 3 页约 35s, 乱码降到 ~3.6%)
    // 实测代价接近 2 倍而收益仅约 1.7pp, 故默认走 font; 需要品名纯净时显式传 hook。
    names: /^hook$/i.test(String(sp.get("names") || "")) ? "hook" : "font",
  };
}

/*
 * 批量询价参数: qs 支持 JSON 数组 / 逗号分隔 / 多个同名参数, 也兼容 q=a,b。
 * 其余参数(模式/页数/排序/缓存)与单条查询完全一致, 内部逐条复用 parseRequest。
 */
function parseBatchRequest(input) {
  const sp = toSearchParams(input);
  let qs = sp.getAll("qs").flatMap((v) => String(v).split(/[,，]/));
  if (!qs.filter((s) => s.trim()).length) {
    qs = String(sp.get("q") || "").split(/[,，]/);
  }
  const seen = new Set();
  qs = qs.map((s) => String(s || "").trim()).filter((s) => {
    if (!s || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  if (!qs.length) {
    const e = new Error("缺少查询词 qs");
    e.status = 400;
    e.hint = "用法: POST /api/v1/ysbang/batch {\"qs\":[\"化积口服液\",\"藿香正气颗粒\"],\"mode\":\"cheapest\"}, 或 GET ?qs=a,b";
    throw e;
  }
  if (qs.length > 10) {
    const e = new Error("一次最多 10 个品种");
    e.status = 400;
    e.hint = "品种多时请分批调用: 单次 10 个以内既能并发又能被缓存覆盖重复项。";
    throw e;
  }
  // 单条基础参数: 用一个占位词跑 parseRequest, 再把 q 换成真实词
  const base = parseRequest(Object.assign({}, Object.fromEntries(sp.entries()), { q: qs[0] }));
  return { base, qs };
}

// 现有药师帮标签(带 url, 用于挑选搜索页而不是后台管理页)
async function ysbTabs() {
  try {
    const info = JSON.parse(dataText(await callTool("get_windows_and_tabs", {}, 15000)));
    const out = [];
    for (const w of info.windows || []) {
      for (const t of w.tabs || []) {
        if (t && typeof t.url === "string" && t.url.indexOf("dian.ysbang.cn") >= 0) out.push(t);
      }
    }
    return out;
  } catch (e) {
    return []; // 拿不到就当没有, 只是可能复用到别的页面, 不影响数据
  }
}

/*
 * 节奏拟人化(v1.4.0)
 * ---------------------------------------------------------------------------
 * 2026-10-23 实测: 连续 ~35 次固定节奏(8s 节流 + 固定 1.2s 导航等待)的搜索后,
 * 网关开始成片 504 —— 拦的是「请求形态规律」, 不是单次行为。补第③层:
 *   1) 随机延时   —— 所有固定 sleep 换成 [min,max] 随机区间
 *   2) 走入框搜索 —— 优先往 input.searchKey 逐段打字 + 点 .search-btn,
 *                    失败再退回 URL 导航(打字节奏由 Node 侧分块注入产生)
 *   3) 浏览滚动   —— 首屏就绪后按概率做几段随机 scrollBy, 偶发长停顿
 */
const hSleep = (min, max) => sleep(min + Math.floor(Math.random() * Math.max(1, max - min)));

// 逐段把关键词「打」进搜索框并点搜索按钮。
// 分块注入 + Node 侧随机间隔 = 打字节奏; execCommand 走原生编辑命令, 输入事件可信。
// 返回 true 表示已点搜索(是否真的切换成功交给 waitReady 校验), false 表示退回导航。
async function typeSearch(tabId, q) {
  const openJs = `
var inp = document.querySelector("input.searchKey");
if (!inp) return { ok: false, why: "no-input" };
inp.focus();
inp.select();
document.execCommand("selectAll");
document.execCommand("delete");
return { ok: true };
`;
  const open = await jsEval(tabId, openJs);
  if (!open || !open.ok) return false;
  // 分块打字: 每块 1~3 个字符, 块间 90~280ms
  let pos = 0;
  while (pos < q.length) {
    const n = 1 + Math.floor(Math.random() * 3);
    const chunk = q.slice(pos, pos + n);
    pos += n;
    const putJs = `document.execCommand("insertText", false, ${JSON.stringify(chunk)}); return { val: document.querySelector("input.searchKey") ? document.querySelector("input.searchKey").value : "" };`;
    const r = await jsEval(tabId, putJs);
    if (!r || !r.val || r.val.indexOf(chunk) < 0) return false; // 注入失败, 退回导航
    await hSleep(90, 280);
  }
  const clickJs = `
var b = document.querySelector(".search-btn");
if (!b) return { ok: false, why: "no-btn" };
b.click();
return { ok: true };
`;
  const clicked = await jsEval(tabId, clickJs);
  return !!(clicked && clicked.ok);
}

// 模拟人的浏览滚动: 2~4 段随机下滚, 再回到顶部附近
async function humanScroll(tabId) {
  const steps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < steps; i++) {
    await jsEval(tabId, `window.scrollBy({ top: ${180 + Math.floor(Math.random() * 420)}, behavior: "smooth" }); return { ok: true };`);
    await hSleep(240, 620);
  }
  await hSleep(180, 500);
  await jsEval(tabId, `window.scrollTo({ top: ${Math.floor(Math.random() * 120)}, behavior: "smooth" }); return { ok: true };`);
}

// 页面当前 hash 里的 searchkey 是否已经是目标关键词(只回布尔, 不回 URL)
async function queryMatches(tabId, q) {
  const js = `
let h = "";
try { h = decodeURIComponent(location.hash || ""); } catch (e) { h = ""; }
return { ok: h.indexOf(${JSON.stringify("searchkey=" + q)}) >= 0 };
`;
  const r = await jsEval(tabId, js);
  return !!(r && r.ok);
}

// 点分页按钮并等待页码变化; 返回 {ok, state, why}
async function clickPager(tabId, selector, waitMs, q) {
  const before = (await jsEval(tabId, statJs(q))) || {};
  const clickJs = `
const b = document.querySelector(${JSON.stringify(selector)});
if (!b) return { ok: false, why: "no-btn" };
if (b.disabled || /disabled/.test(String(b.className))) return { ok: false, why: "disabled" };
b.click();
return { ok: true };
`;
  const r = await jsEval(tabId, clickJs);
  if (!r || !r.ok) return { ok: false, why: (r && r.why) || "click-failed", state: before };
  reqCounter++; // 点击生效 = 一次列表重请求

  const deadline = Date.now() + (waitMs || 9000);
  while (Date.now() < deadline) {
    await sleep(500);
    const s = await jsEval(tabId, statJs(q));
    if (s && s.vcode) return { ok: false, why: "vcode", state: s };
    // 页码变了 + 有卡片 + 首条指纹变了 = 列表确实换了一批
    if (s && s.page != null && before.page != null && s.page !== before.page && s.n > 0 && s.fh !== before.fh) {
      return { ok: true, state: s };
    }
  }
  return { ok: false, why: "timeout", state: before };
}

// 等页面真正切到目标关键词并渲染出列表。
// 必要性: 导航后 SPA 的旧列表仍留在 DOM 里, 直接解码会读回上一个搜索词的数据。
async function waitReady(tabId, q, tries) {
  let last = null;
  for (let i = 0; i < (tries || 20); i++) {
    last = await jsEval(tabId, statJs(q));
    if (last && last.vcode) return last; // 命中验证码立即返回, 不在原地空等
    if (last && last.needLogin) return last;
    if (last && last.qok && last.hasList && last.ready === "complete") return last;
    await sleep(700);
  }
  return last;
}

// 回到第一页: SPA 复用了用户的标签时, 可能停在任意页
async function toFirstPage(tabId, q) {
  for (let i = 0; i < MAX_PAGES; i++) {
    const s = await jsEval(tabId, statJs(q));
    if (!s || s.page == null || s.page <= 1) return s;
    const r = await clickPager(tabId, ".pagination-prev", 9000, q);
    if (!r.ok) return r.state || s;
  }
  return await jsEval(tabId, statJs(q));
}

// 装挂钩(幂等): SPA hash 路由不重载文档, 装一次对后续所有关键词/翻页都有效
async function installHook(tabId) {
  try {
    const r = await jsEval(tabId, hookJs("install"));
    if (!r || !r.ok) log("warn", `ysbang hook install odd result: ${JSON.stringify(r).slice(0, 200)}`);
    return !!(r && r.ok);
  } catch (e) {
    log("warn", `ysbang hook install failed: ${e.message}`);
    return false;
  }
}

// 从捕获里取当前页商品(挂钩路径)
async function extractViaHook(tabId, opts) {
  return extractSerp(tabId, hookJs("extract"), Object.assign({ flag: "hasList", label: "ysbang-hook", tries: 8 }, opts));
}

// 点排序项(如「销量」/「默认排序」)并等待列表换一批。
// 用途: 回到第 1 页时 SPA 会直接用缓存、不重新请求接口, 挂钩就抓不到第 1 页的
// 解密数据; 而切换排序一定会重新请求, 且页码仍是 1。
async function clickSort(tabId, text, waitMs, q, opts) {
  const before = (await jsEval(tabId, statJs(q))) || {};
  // text 支持数组: 药师帮的排序项文案会随版本变(价格/价格从低到高/低价), 先精确再包含。
  // opts.index: 文字全不中时的兜底序号 —— 价格排序项实测是第 3 个 .sort-item 且 innerText 为空
  // (只用图标表达升降序), 所以纯文字匹配永远点不到它。
  const cands = Array.isArray(text) ? text : [text];
  const fallbackIdx = opts && Number.isInteger(opts.index) ? opts.index : -1;
  const clickJs = `
const items = Array.from(document.querySelectorAll('.sort-item'));
const cands = ${JSON.stringify(cands)};
const fallbackIdx = ${fallbackIdx};
let el = null;
for (const c of cands) {
  el = items.filter(function (x) { return (x.innerText || '').trim() === c; })[0];
  if (el) break;
}
if (!el) {
  for (const c of cands) {
    el = items.filter(function (x) { return (x.innerText || '').indexOf(c) >= 0; })[0];
    if (el) break;
  }
}
if (!el && fallbackIdx >= 0 && items.length > fallbackIdx) el = items[fallbackIdx];
if (!el) return { ok: false, why: 'no-sort', have: items.map(function (x) { return (x.innerText || '').trim() || '(空)'; }).join('/') };
const label = (el.innerText || '').trim() || ('sort-item[' + items.indexOf(el) + ']');
el.click();
return { ok: true, label: label };
`;
  const r = await jsEval(tabId, clickJs);
  if (!r || !r.ok) return { ok: false, why: (r && r.why) || "click-failed", state: before, have: r && r.have };
  reqCounter++; // 点击生效 = 一次列表重请求

  const deadline = Date.now() + (waitMs || 9000);
  while (Date.now() < deadline) {
    await sleep(500);
    const s = await jsEval(tabId, statJs(q));
    if (s && s.vcode) return { ok: false, why: "vcode", state: s };
    if (s && s.hasList && s.n > 0 && s.fh !== before.fh) return { ok: true, state: s, label: r.label };
  }
  // 点击确实发生了, 只是列表指纹没变(可能本来就是这个顺序) —— 交给调用方用价格判据决定
  return { ok: false, why: "no-change", state: before, label: r.label };
}

// 解码后的价格是否单调递增 —— 判断「价格从低到高」排序是否真的生效的唯一可靠判据
// (排序控件点了不等于生效: 同一点击可能是在升/降序间切换, 也可能点了没反应)
function isPriceAscending(items) {
  const nums = [];
  for (const c of items || []) {
    const v = parseFloat(String(c.price || "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(v)) nums.push(v);
    if (nums.length >= 10) break;
  }
  if (nums.length < 3) return false;
  for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) return false;
  return true;
}

function priceNum(c) {
  const v = parseFloat(String((c && c.price) || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(v) ? v : null;
}

/*
 * v1.5.0 多标签并发(对照 Tencent/BrowserSkill 的 per-session queue + shared browser control)
 * ---------------------------------------------------------------------------
 * 并发的收益在延迟, 风险在「请求间隔被压缩」。所以拆成两层:
 *   1) 站点槽位(本文件 module.exports 里的 concurrency=3 + lib/util.withBrowserSlot):
 *      允许多次调用同时跑, 各自占一个标签, 不再全局排队。
 *   2) 页级节流闸(pagePacer): 所有真正触发列表请求的动作(搜索/翻页/并发页导航)
 *      共用一把闸, 按 [900,2100]ms 随机间隔发号 —— 3 个标签的总节奏仍接近单人翻页。
 *
 * 页级并发的可行性有前提: 新建标签直接导航到 #/indexContent?...&page=N 必须被 SPA 接受。
 * 这一点没有文档保证, 所以做成「探测式」: 第一次并发先只开 1 个 worker 验证页码,
 * 对不上就把 pageUrlMode 记为 no, 本次及后续全部退回串行翻页(慢但一定对)。
 * 已经加载过的标签不能改 hash 翻页(该站路由会规范化回原页码), 这一点串行路径同理。
 */
const MAX_TABS = 3;              // 单次调用最多开几个标签
// 进程内「已被某次调用占用」的标签。批量/并发时两个 worker 若抢到同一个 indexContent
// 标签, 会互相把搜索词改掉, 两边都拿到对方的词的结果 —— 必须互斥。
const busyTabs = new Set();
const pagePacer = createPacer(900, 2100);
let pageUrlMode = "unknown";     // unknown | ok | no: 新标签直达 page=N 是否被接受
let pageUrlNoAt = 0;             // 判定为 no 的时刻(10 分钟后允许重试, 免得上一次偶发失败永久串行)
/*
 * v1.5.2: 「页级并发会拿到半渲染数据」的冷却标记。
 * 实测该站 SPA 不保证冷启动直达 page=N: 窗口先渲第 1 页, 再切到第 N 页, 切换过程中
 * 只画了十几张卡就停住。默认识别为「数据不完整」并整轮降级串行, 同时在冷却期内不再
 * 尝试并发 —— 否则每次调用都白开 2~3 个窗口、白发一轮请求, 反而抬高风控风险。
 */
let parallelBadUntil = 0;
const PARALLEL_BAD_MS = 30 * 60 * 1000;
const PAGE_URL_RETRY_MS = 10 * 60 * 1000;

// 只读 hash 里的页码(轻量: 不碰 DOM 卡片, 不读 innerText)
const PAGE_JS = `
let h = "";
try { h = decodeURIComponent(location.hash || ""); } catch (e) { h = ""; }
const m = h.match(/[?&]page=(\\d+)/);
const vc = document.querySelector('iframe[src*="captcha"],[class*="yidun"],[class*="geetest"],.nc_container');
return { page: m ? +m[1] : null, vcode: false, vcDom: !!vc };
`;

// 并发页路径当前是否可用(no 状态有 10 分钟半衰期)
function pageUrlUsable() {
  if (pageUrlMode === "no" && Date.now() - pageUrlNoAt > PAGE_URL_RETRY_MS) {
    pageUrlMode = "unknown";
    log("browser", "ysbang page-url 冷却结束, 允许再次尝试并发页");
  }
  return pageUrlMode !== "no";
}
function markPageUrlUnsupported() {
  if (pageUrlMode !== "no") pageUrlNoAt = Date.now();
  pageUrlMode = "no";
}

// 降级原因 -> 给调用方看的人话(写在响应 concurrency.hint 里, 不只在日志)
const DEGRADE_HINT = {
  tab_reuse_extension_reused_tab:
    "扩展把并发开的新窗口判成「URL 已打开」而复用了同一标签(该站是 hash 路由), 需重载打过 v1.5.1 补丁的扩展; 未重载前并发自动降级为串行, 结果仍正确",
  parallel_incomplete:
    "并发标签只渲染出半页卡片就停住(该站 SPA 冷启动不保证直达 page=N), 已作废并发结果改用串行, 本次结果完整; 30 分钟内不再尝试并发",
  page_url_not_accepted:
    "新标签没能直达指定页码(该站用 hash 路由 + SPA 接管分页), 已自动降级串行, 结果完整",
};

function fallbackError(msg, pageUrlUnsupported, tabReuse, incomplete) {
  const e = new Error(msg);
  e.__ysbFallback = true;
  if (pageUrlUnsupported) e.__ysbPageUrlUnsupported = true;
  // incomplete: 页打开了、也抽到了数据, 但条数明显少于该页应有条数(渲染没补齐)
  if (incomplete) e.__ysbIncomplete = true;
  // tabReuse: 并发的「新标签」其实是同一个标签(扩展的 chrome_navigate 在 hash 路由站点上
  // 会把不同 page 的 URL 判成同一个而直接复用), 与 SPA 是否接受 page 参数无关
  if (tabReuse) e.__ysbTabReuse = true;
  return e;
}

/*
 * 选一个搜索标签并把关键词切到目标词。
 *   1) 已有搜索页(indexContent) -> 复用, 优先走入框打字, 失败退回 URL 导航
 *   2) 只有其他药师帮页(店铺后台等) -> 复用, 但会动到用户页面, 用 reused_tab 提示
 *   3) 一个都没有 -> 自己开独立窗口(不激活, 完成即关)
 */
async function openSearchTab(p) {
  const url = buildUrl(p.q, 1, p.pagesize);
  const tabs = await ysbTabs();
  // 排除已被别处占用的标签: 抢同一个标签 = 互相改搜索词 = 两边都拿到错的词
  const free = tabs.filter((t) => !busyTabs.has(t.tabId));
  const searchTab = free.filter((t) => t.url.indexOf("/indexContent") >= 0)[0];
  const target = searchTab || free[0] || null;

  if (target) {
    busyTabs.add(target.tabId);
    const page = { tabId: target.tabId, windowId: target.windowId, mode: "tab", keepOpen: false };
    if (!(await queryMatches(page.tabId, p.q))) {
      // v1.4.0: 优先走入框打字搜索(更像人); 打字/点击失败再退回 URL 导航
      let typed = false;
      if (searchTab) typed = await typeSearch(page.tabId, p.q);
      if (typed) {
        log("browser", "ysbang search via input typing");
      } else {
        await callTool("chrome_navigate", { tabId: page.tabId, url, background: true }, 40000);
      }
      reqCounter++; // 一次搜索请求
      pagePacer.mark();
      await hSleep(1300, 2800);
    }
    return { page, reused: true };
  }

  const page = await openPage(url, { siteMode: "window" });
  busyTabs.add(page.tabId);
  reqCounter++; // 新开页面 = 一次搜索请求
  pagePacer.mark();
  return { page, reused: false };
}

// 并发路径的单页抓取: 自开标签 -> 直达 page=N -> 字体解码。
// 必须在 decode 前确认 st.page 就是 N, 否则这一页的数据会挂错页码。
async function fetchPageDirect(p, pageNo, guardOpts, totalHint) {
  await pagePacer.wait();
  const url = buildUrl(p.q, pageNo, p.pagesize);
  const pg = await openPage(url, { siteMode: "window" });
  /*
   * 关键诊断: openPage 本该开新窗口, 但如果扩展把 URL 判成「已打开」而复用了标签,
   * 返回的 tabId 就会和别的 worker 撞车 —— busyTabs 里已经有人占着它。
   * 这正是并发拿不到第 2/3 页的真正原因(实测日志里三个 worker 同一个 tabId),
   * 单独立一个 reason, 免得跟「SPA 不吃 page 参数」混在一起查。
   */
  const tabCollided = busyTabs.has(pg.tabId);
  busyTabs.add(pg.tabId); // 自开标签也要占位: 它的 URL 也是 indexContent, 否则会被别的调用抢去改词
  reqCounter++;
  try {
    const st = await waitReady(pg.tabId, p.q, 22);
    if (st && st.vcode) {
      markBlocked("并发页 " + pageNo);
      blockError("并发页 " + pageNo);
    }
    if (st && st.needLogin) {
      await needsHuman(pg, "药师帮需要登录", "并发抓取时登录态失效; 已把页面切到前台, 登录后重试即可。");
    }
    if (!st || !st.qok) {
      throw fallbackError(`并发页 ${pageNo}: 页面没有切到目标搜索词`, true);
    }
    /*
     * 页码确认(v1.5.1 修复时序竞态):
     * 实测日志里同一进程内 "probe ok page=2" 与 "实际 1" 交替出现 —— 不是 page 参数
     * 不被接受, 而是 waitReady 在 document.readyState=complete 就返回, 此时 SPA 还没
     * 把 hash 里的 page=N 应用到路由, 单次读取必然读到上一页。改成短轮询(最多 ~2.4s)。
     * 另外 hash 里没有 page= 参数时按第 1 页处理(该站会规范化掉 page=1)。
     */
    let seenPage = st.page;
    let pageOk = (seenPage == null ? 1 : seenPage) === pageNo;
    for (let i = 0; i < 6 && !pageOk; i++) {
      await sleep(400);
      const cur = await jsEval(pg.tabId, PAGE_JS);
      if (cur && cur.vcode) { markBlocked("并发页 " + pageNo); blockError("并发页 " + pageNo); }
      seenPage = cur ? cur.page : seenPage;
      pageOk = (seenPage == null ? 1 : seenPage) === pageNo;
    }
    if (!pageOk) {
      throw fallbackError(
        `并发页 ${pageNo}: 页码参数未被接受(实际 ${seenPage == null ? 1 : seenPage})${tabCollided ? "; 且拿到的标签与其它 worker 相同(扩展复用了标签)" : ""}`,
        true,
        tabCollided
      );
    }
    // 页码对上了还要给列表一点重渲染时间, 否则可能抽到上一页的卡片
    await sleep(250);
    /*
     * 抓取目标条数:
     * 该站整页固定 60 条, 末页可能不足。知道 total 就能算出本页应有几条, 不知道就按整页算。
     * 为什么要这个: 真机实测页面会「先画十几张, 停 3~5 秒再补满」, 只看「两次读数相同」
     * 会在中间态就收工(3 页只拿到 60/13/6)。够数即返回, 不够才退化成静置判定。
     */
    const remain = totalHint > 0 ? totalHint - (pageNo - 1) * DEFAULT_PAGESIZE : DEFAULT_PAGESIZE;
    const expect = Math.max(1, Math.min(DEFAULT_PAGESIZE, remain));
    const d = await extractSerp(pg.tabId, DECODE_JS, Object.assign({
      flag: "hasList", label: "ysbang-p" + pageNo, tries: 20, settleMs: 6000, expect,
    }, guardOpts || {}));
    /*
     * 抽取后再校验一次页码(v1.5.2, 真机实锤):
     * 窗口 URL 明明带 page=2, 但该站 SPA 会把 hash 改写回 page=1 并渲染第 1 页内容 ——
     * 前置检查读到的是「改写前」的 page=2, 于是空欢喜一场(实测抽取时 hash 已是 page=1)。
     * 这种情况不是「渲染慢」, 是这条路根本不成立: 判死 + 记忆, 交给串行。
     */
    if (d && d.page != null && d.page !== pageNo) {
      throw fallbackError(
        `并发页 ${pageNo}: 抽取时页面已回到第 ${d.page} 页(该站会改写冷启动页号)`,
        true
      );
    }
    return { page: pageNo, items: (d && d.items) || [], total: d && d.total, count: (d && d.count) || 0, expect };
  } finally {
    busyTabs.delete(pg.tabId);
    await closePage(pg);
  }
}

/*
 * 页级并发: 协调标签负责搜索 + 第 1 页(不额外发请求), 其余页各开一个标签直达。
 * 只在 names=font(默认, 不需要挂钩预热)时启用 —— 挂钩模式每页要额外预热一次请求,
 * 并发反而把请求数翻倍, 得不偿失。
 */
async function fetchParallelPages(p) {
  const { page: coord, reused } = await openSearchTab(p);
  try {
    let st = await waitReady(coord.tabId, p.q, 22);
    if (st && st.vcode) { markBlocked("搜索首屏"); blockError("搜索首屏"); }
    if (st && st.needLogin) await needsHuman(coord, "药师帮需要登录", "该接口复用浏览器现有登录态; 已把页面切到前台, 登录后再次调用即可。");
    if (!st || !st.qok) throw fallbackError("并发首屏没有切到目标搜索词", true);
    if (!st.hasList) {
      const e = new Error("药师帮搜索页没有渲染出商品列表");
      e.status = 504;
      e.hint = "可能是未登录、搜索词无结果, 或浏览器窗口被最小化导致后台标签被冻结; 把窗口切到前台后重试。";
      throw e;
    }
    st = await toFirstPage(coord.tabId, p.q);
    if (Math.random() < 0.5) await humanScroll(coord.tabId);

    const totalKnown = st.total != null && st.total > 0;
    // 页数估计: 有 total 时按每页 60 条换算, 避免对「只有 1 页结果」的词多开标签白跑请求
    const byTotal = totalKnown ? Math.min(MAX_PAGES, Math.ceil(st.total / DEFAULT_PAGESIZE)) : null;
    let pageCount = 0;
    if (p.pages && p.pages >= 2) pageCount = byTotal ? Math.min(p.pages, byTotal) : p.pages;
    else if (byTotal) pageCount = byTotal;
    if (pageCount < 2) {
      // 页数未知(该站「共 N 条」经常不显示)且没指定 pages: 并发无从下手, 退回串行翻页
      throw fallbackError("无法确定总页数, 并发页不可用", false);
    }

    const guard = {
      guards: async (dd) => { if (dd && dd.needLogin) await needsHuman(coord, "药师帮登录态失效"); },
    };

    const d1 = await extractSerp(coord.tabId, DECODE_JS, Object.assign({
      flag: "hasList", label: "ysbang-p1", tries: 12, settleMs: 4000,
    }, guard));
    const results = [{ page: 1, items: (d1 && d1.items) || [], count: (d1 && d1.count) || 0 }];
    let total = st.total != null ? st.total : (d1 && d1.total);

    const queue = [];
    for (let n = 2; n <= pageCount; n++) queue.push(n);
    const failed = [];
    let abort = null;

    /*
     * 探测(只在 pageCount>=4 时做):
     * 探测本身会独占一页, 3 页场景探测完只剩 1 页可并发 —— 并发度恒为 1, 等于没并发
     * (真机实测日志: "ysbang parallel pages=3 tabs=1 skip=2")。所以 3 页及以下直接
     * 并发发车, 走不通由 workers 的 abort 统一降级; 4 页以上才值得先花一页做确认。
     */
    if (pageUrlMode === "unknown" && pageCount >= 4 && queue.length >= 2) {
      const probeNo = queue.shift();
      try {
        const pr = await fetchPageDirect(p, probeNo, guard, total);
        pageUrlMode = "ok";
        results.push(pr);
        log("browser", `ysbang page-url probe ok page=${probeNo}`);
      } catch (e) {
        // 探测失败说明「新标签直达页码」这条路不可用, 记住这个结论(带冷却, 之后会再试)
        if (e && e.__ysbPageUrlUnsupported) markPageUrlUnsupported();
        throw e;
      }
    }

    const tabs = Math.max(1, Math.min(p.tabs, queue.length, MAX_TABS));
    if (queue.length) log("browser", `ysbang parallel pages=${pageCount} tabs=${tabs} skip=${results.length}`);

    const workers = Array.from({ length: tabs }, async () => {
      while (queue.length && !abort) {
        const n = queue.shift();
        try {
          const r = await fetchPageDirect(p, n, guard, total);
          results.push(r);
          if (r.total != null) total = r.total;
        } catch (e) {
          // 验证码/需登录/页码不被接受 => 整轮停手, 不再开着别的标签继续撞
          if (e.__ysbFallback || e.status === 429 || e.needs_human) { abort = e; return; }
          failed.push({ page: n, error: e.message });
          log("warn", `ysbang parallel page ${n} failed: ${e.message}`);
        }
      }
    });
    await Promise.all(workers);

    if (abort) {
      if (abort.__ysbPageUrlUnsupported) markPageUrlUnsupported();
      throw abort;
    }

    results.sort((a, b) => a.page - b.page);
    /*
     * 少采自检: 某页抽到的条数不到「应有条数」的 60%, 基本就是渲染没补齐(而不是末页真的这么少)。
     * 不静默通过 —— 写进 concurrency.short_pages, 调用方一眼能看出哪页不可信。
     */
    const shortPages = results
      .filter((r) => r.count > 0 && r.count < Math.max(1, Math.round((r.expect || DEFAULT_PAGESIZE) * 0.6)))
      .map((r) => r.page);
    const items = [];
    const seen = new Set();
    for (const r of results) {
      for (const c of r.items || []) {
        const key = [c.name, c.factory, c.warehouse || c.shop, c.price].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        if (!p.include_zero && (!c.price || c.price === "0.00" || !c.price_ok)) continue;
        items.push(Object.assign({}, c, { page: r.page }));
      }
    }

    /*
     * 完整性闸门(v1.5.2): 只要有页「明显少采」, 本轮并发结果整块作废, 交回外层走串行。
     * 宁可慢, 不能把 60/11/6 这种半截数据当成结论返回(实测 3 页并发只拿到 77 条, 串行是 171)。
     */
    if (shortPages.length) {
      parallelBadUntil = Date.now() + PARALLEL_BAD_MS;
      throw fallbackError(
        `并发页数据不完整(渲染未补齐): 第 ${shortPages.join(",")} 页条数不足`,
        false, false, true
      );
    }

    const pagesFetched = results.length;
    const out = buildPayload(p, {
      items,
      pagesFetched,
      total: total != null ? total : items.length,
      mode: p.mode,
      reused,
      namesMode: "font",
      decodeModes: [],
      reachedEnd: total != null && items.length >= total,
      hookStats: null,
      extra: {
        concurrency: {
          mode: "page_parallel",
          tabs,
          page_url_mode: pageUrlMode,
          pages_scanned: results.map((r) => r.page),
          failed_pages: failed.length ? failed : undefined,
          short_pages: shortPages.length ? shortPages : undefined,
        },
      },
    });
    log("browser", `ysbang parallel ok pages=${pagesFetched} n=${items.length} requests=${reqCounter}`);
    return out;
  } finally {
    if (reused) coord.keepOpen = true;
    busyTabs.delete(coord.tabId);
    await closePage(coord);
  }
}

// 统一收尾: 排序 / cheapest 截取 / 输出字段。串行与并发两条路径共用, 避免两套口径。
function buildPayload(p, ctx) {
  const items = ctx.items;
  if (p.sort) {
    const k = (c) => {
      const v = parseFloat(String(c.price || "").replace(/[^\d.]/g, ""));
      return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
    };
    items.sort((a, b) => (p.sort === "price_asc" ? k(a) - k(b) : k(b) - k(a)));
  }
  const prices = items.map((c) => parseFloat(String(c.price || "").replace(/[^\d.]/g, ""))).filter((v) => Number.isFinite(v));
  const decodeMode = ctx.decodeModes && ctx.decodeModes.length
    ? (ctx.decodeModes.every((m) => m === "hook") ? "hook" : (ctx.decodeModes.includes("hook") ? "mixed" : "font"))
    : "font";

  if (p.mode === "cheapest") {
    const asc = items.slice().sort((a, b) => {
      const x = priceNum(a);
      const y = priceNum(b);
      return (x == null ? Infinity : x) - (y == null ? Infinity : y);
    });
    const picked = asc.slice(0, p.top);
    const nums = picked.map(priceNum).filter((v) => v != null);
    const complete = !!ctx.reachedEnd || (ctx.total != null && items.length >= ctx.total);
    return Object.assign({
      source: "ysbang via web-to-openapi",
      fetched_at: new Date().toISOString(),
      query: p.q,
      mode: "cheapest",
      pages_fetched: ctx.pagesFetched,
      requests: reqCounter,
      total: ctx.total != null ? ctx.total : items.length,
      scanned: items.length,
      complete,
      // 只有扫完全部结果, price_min 才是确定的全站最低价
      lowest_is_global: complete,
      count: picked.length,
      price_min: nums.length ? Math.min.apply(null, nums) : null,
      price_max: nums.length ? Math.max.apply(null, nums) : null,
      decode_mode: decodeMode,
      names_mode: ctx.namesMode,
      names_diag: ctx.hookStats || undefined,
      reused_tab: ctx.reused,
      items: picked,
    }, ctx.extra || {});
  }

  return Object.assign({
    source: "ysbang via web-to-openapi",
    fetched_at: new Date().toISOString(),
    query: p.q,
    mode: "full",
    pages_fetched: ctx.pagesFetched,
    requests: reqCounter,
    total: ctx.total != null ? ctx.total : items.length,
    count: items.length,
    price_min: prices.length ? Math.min.apply(null, prices) : null,
    price_max: prices.length ? Math.max.apply(null, prices) : null,
    // hook = 全部页走解密数据(品名价格全明文); font = 全部走字形解码; mixed = 两者混用
    decode_mode: decodeMode,
    names_mode: ctx.namesMode,
    names_diag: ctx.hookStats || undefined,
    reused_tab: ctx.reused,
    items,
  }, ctx.extra || {});
}

// 串行路径(旧行为, 并发不可用时的兜底; 熔断/缓存已由 fetchPrices 统一处理)
async function fetchSequential(p, opts) {
  const degrade = (opts && opts.degrade) || null;
  const { page, reused } = await openSearchTab(p);

  try {
    // 首屏: 必须等「目标关键词 + 列表出现 + 文档加载完」三者同时成立
    let st = await waitReady(page.tabId, p.q, 22);
    if (st && st.vcode) {
      markBlocked("搜索首屏");
      blockError("搜索首屏");
    }
    if (st && st.needLogin) {
      await needsHuman(page, "药师帮需要登录", "该接口复用浏览器现有登录态; 已把页面切到前台, 登录后再次调用即可。");
    }
    if (!st || !st.qok) {
      const e = new Error("药师帮页面没有切换到目标搜索词");
      e.status = 504;
      e.hint = "导航到搜索页失败(可能被站内路由拦截)。可手动在浏览器打开一次药师帮搜索页后重试。";
      throw e;
    }
    if (!st.hasList) {
      const e = new Error("药师帮搜索页没有渲染出商品列表");
      e.status = 504;
      e.hint = "可能是未登录、搜索词无结果, 或浏览器窗口被最小化导致后台标签被冻结; 把窗口切到前台后重试。";
      throw e;
    }

    // 回到第 1 页(若停在第 N 页); 其中翻页请求已在 clickPager 内部计数
    st = await toFirstPage(page.tabId, p.q);

    // v1.4.0 节奏拟人化: 首屏就绪后像人一样扫一眼列表, 偶发「接水/回消息」式长停顿
    if (Math.random() < 0.7) await humanScroll(page.tabId);
    if (Math.random() < 0.12) await hSleep(2200, 4800);


    /*
     * 挂钩预热: 装挂钩后必须让接口重新请求一次, 才能捕获到解密数据。
     * 做法是「翻到第 2 页再翻回第 1 页」——复用已有的分页控件逻辑,
     * 不碰搜索框(实测往 input 里塞值+派发事件不稳定), 也不依赖改 hash
     * (该站 hash 路由会规范化, 直接改会被弹回原页码)。
     * 两次翻页都失败(如只有 1 页结果)时 useHook=false, 全程退回字体解码。
     */
    let useHook = false;
    const installed = p.names === "hook" ? await installHook(page.tabId) : false;
    if (p.names === "hook") log("browser", `ysbang hook installed=${installed}`);
    if (installed) {
      /*
       * 让「第 1 页」在挂钩就位后重新请求一次。两条路:
       *   优先 切排序再切回(销量 -> 默认排序): 一定重新请求, 页码仍是 1, 顺序最终还原
       *   兜底 翻到第 2 页再翻回第 1 页: 第 1 页可能命中 SPA 缓存而抓不到(实测会)
       */
      let primed = false;
      await hSleep(350, 950);
      const s1 = await clickSort(page.tabId, "销量", 9000, p.q);
      log("browser", `ysbang hook prime-sort 销量 ok=${s1.ok} why=${s1.why || ""}`);
      if (s1.ok) {
        await hSleep(400, 1100);
        const s2 = await clickSort(page.tabId, "默认排序", 9000, p.q);
        log("browser", `ysbang hook prime-sort 默认排序 ok=${s2.ok} why=${s2.why || ""}`);
        primed = s2.ok;
      }
      if (!primed) {
        const fwd = await clickPager(page.tabId, ".pagination-next", 9000, p.q);
        log("browser", `ysbang hook prime-fwd ok=${fwd.ok} why=${fwd.why || ""}`);
        if (fwd.ok) {
          const back = await clickPager(page.tabId, ".pagination-prev", 9000, p.q);
          log("browser", `ysbang hook prime-back ok=${back.ok} why=${back.why || ""}`);
          primed = back.ok;
        }
      }
      if (primed) {
        const probe = await extractViaHook(page.tabId, { tries: 3 });
        useHook = !!(probe && probe.items && probe.items.length);
        log("browser", `ysbang hook armed=${useHook} cap=${probe && probe.capCount} probe=${JSON.stringify(probe && { n: probe.items && probe.items.length, hooked: probe.hooked, pe: probe.parse_error })}`);
      }
    }

    const items = [];
    const seen = new Set();
    const modes = [];
    let pagesFetched = 0;
    let total = st.total;
    let reachedEnd = false; // 是否翻到了最后一页(下一页按钮 disabled)
    // 挂钩合并诊断(v1.5.0): 为什么合并了/为什么没合并, 要能在响应里看到,
    // 而不是只有一行日志。names_diag.skipped + reasons 就是「捕获源选择」的账本。
    const hookStats = { merged: 0, skipped: 0, reasons: {}, warnings: [] };

    for (let i = 0; i < MAX_PAGES; i++) {
      if (p.pages && pagesFetched >= p.pages) break;

      /*
       * 分工(2026-10-23 实测后的最优解):
       *   价格  <- 字体解码(DECODE_JS): 主列表接口的价格是渲染片段密文, 且被扩展
       *            的响应脱敏器替换成 [BLOCKED], 出不了页面; 而 canvas 字形匹配
       *            在页面内直接还原, 实测 100% 可解 -> 价格权威来源
       *   文本  <- 挂钩明文(HOOK): 品名/厂家/商家/规格/有效期在解密数据里是纯明文,
       *            可修掉字体解码对促销项品名的 ~5% 乱码 -> 文本权威来源
       * 两者按位合并(同页同序); 数量对不上就不合并, 只保留字体解码结果。
       */
      const guard = {
        guards: async (dd) => {
          if (dd && dd.needLogin) await needsHuman(page, "药师帮登录态失效");
        },
      };

      const d = await extractSerp(page.tabId, DECODE_JS, Object.assign({ flag: "hasList", label: "ysbang", tries: 8 }, guard));
      if (!d || !d.items) break;
      if (d.total) total = d.total;

      let nameFilled = false;
      if (useHook) {
        /*
         * v1.5.0: 按 reason 决定要不要重试 —— 只有「捕获还没到」值得等。
         *   no_capture     主列表响应比 DOM 晚到 -> 等 1.5s 再取一次
         *   page_mismatch  节点里是别的页的数据 -> 重试也没用, 直接放弃本页合并
         *   query_mismatch 节点里是别的关键词的数据 -> 同上
         *   ambiguous      两个候选数组长度接近, 分不清主列表 -> 不猜, 放弃合并
         * 旧实现对这些情况一律盲重试 2 轮, 白白多一次页面读取, 还把真实原因埋掉。
         */
        for (let attempt = 0; attempt < 2 && !nameFilled; attempt++) {
          if (attempt) await sleep(1500);
          const h = await extractViaHook(page.tabId, guard);
          const reason = (h && h.reason) || (h && h.items && h.items.length ? null : "no_capture");

          if (!h || !h.items || !h.items.length) {
            hookStats.skipped++;
            if (reason) hookStats.reasons[reason] = (hookStats.reasons[reason] || 0) + 1;
            // 失败也留痕: 是哪一页、哪个 reason、捕获到第几次 —— 重试策略的依据
            if (h && h.stamp) hookStats.last_stamp = { page: d.page, reason: reason, seq: h.stamp.seq, page_match: h.stamp.page_match, main_len: h.stamp.main_len, age_ms: h.stamp.age_ms };
            const retryable = reason === "no_capture";
            log(retryable ? "info" : "warn",
              `ysbang hook 未合并 page=${d.page} reason=${reason} cap=${h && h.capCount} cands=${JSON.stringify(h && h.candidates)} try=${attempt + 1}`);
            if (retryable) continue;
            break;
          }

          /*
           * DOM 卡片数可能多于主列表(额外渲染了秒杀/推荐区块), 所以不能要求数量相等。
           * 改为「按位对齐 + 工厂名匹配率校验」: 主列表在页面最前, 前 n 条应一一对应;
           * 若工厂名匹配率 < 50% 就认定错位, 整页不合并(宁可留字体解码的少量乱码,
           * 也不能把别人的品名贴到这张卡上)。
           */
          const n = Math.min(d.items.length, h.items.length);
          let hit = 0;
          for (let i = 0; i < n; i++) {
            const a = String(d.items[i].factory || "");
            const b = String(h.items[i].factory || "");
            if (a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) hit++;
          }
          const rate = n ? hit / n : 0;
          if (n > 0 && rate >= 0.5) {
            for (let i = 0; i < n; i++) {
              const card = d.items[i];
              const plain = h.items[i];
              if (plain.name) card.name = plain.name;
              if (plain.factory) card.factory = plain.factory;
              if (plain.shop) card.shop = plain.shop;
              if (plain.spec) card.spec = plain.spec;
              if (plain.brand) card.brand = plain.brand;
              if (plain.moq) card.moq = plain.moq;
              if (plain.expiry) card.expiry = plain.expiry;
              if (plain.wholesaleid) card.wholesaleid = plain.wholesaleid;
              card.name_src = "hook";
            }
            nameFilled = true;
            hookStats.merged++;
            /*
             * provenance 回传到响应(v1.5.1): 合并成功时把「这笔明文是哪一次捕获」
             * 写进 names_diag.stamp —— 页内算的戳如果只在日志里, 调用方事后对账
             * 就只能靠时间戳猜。只放 seq/页码是否匹配/年龄/主列表长度, 不放 URL。
             */
            hookStats.stamp = { page: d.page, seq: (h.stamp && h.stamp.seq) || null, page_match: h.stamp ? h.stamp.page_match : null, age_ms: h.stamp ? h.stamp.age_ms : null, main_len: (h.stamp && h.stamp.main_len) || null, aligned: n, match_rate: Math.round(rate * 100) / 100 };
            for (const w of h.warnings || []) if (hookStats.warnings.indexOf(w) < 0) hookStats.warnings.push(w);
            log("browser", `ysbang merge ok n=${n} match=${(rate * 100).toFixed(0)}% seq=${h.stamp && h.stamp.seq} age=${h.stamp && h.stamp.age_ms}ms try=${attempt + 1}`);
          } else {
            hookStats.skipped++;
            hookStats.reasons.align_failed = (hookStats.reasons.align_failed || 0) + 1;
            log("warn", `ysbang hook/dom 对齐失败: n=${n} match=${(rate * 100).toFixed(0)}% (dom=${d.items.length} hook=${h.items.length}) seq=${h.stamp && h.stamp.seq} try=${attempt + 1}`);
            break; // 对齐失败重试同一份数据没有意义, 等下一轮翻页
          }
        }
      }
      if (nameFilled) modes.push("hook");

      let added = 0;
      for (const c of d.items) {
        // 跨页去重: 翻页失败时可能重复拿到同一页
        const key = [c.name, c.factory, c.warehouse || c.shop, c.price].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        if (!p.include_zero && (!c.price || c.price === "0.00" || !c.price_ok)) continue;
        items.push(Object.assign({}, c, { page: d.page }));
        added++;
      }
      pagesFetched++;
      if (added === 0 && pagesFetched > 1 && d.count === 0) break;
      // 已采够目标页数就停, 不要再多点一次「下一页」——
      // 每一次多余的翻页都是一次真实的列表请求, 直接增加风控暴露面。
      if (p.pages && pagesFetched >= p.pages) break;

      // v1.4.0: 页间随机停顿 —— 人翻页前总要扫一下当前页
      if (Math.random() < 0.55) await humanScroll(page.tabId);
      await hSleep(600, 1800);
      const nx = await clickPager(page.tabId, ".pagination-next", 9000, p.q);
      // 翻页途中被抓到验证码: 立刻停手, 不能继续往下翻(继续翻只会让账号更快被标记)
      if (nx.why === "vcode" || (nx.state && nx.state.vcode)) {
        markBlocked("翻页");
        blockError("翻页途中");
      }
      if (!nx.ok) {
        // 下一页按钮 disabled = 已到最后一页, 这是「是否扫完全部结果」最可靠的判据
        // (页面已不再显示「共 N 条」, total 常年为 null)
        if (nx.why === "disabled") reachedEnd = true;
        break;
      }
    }

    const out = buildPayload(p, {
      items,
      pagesFetched,
      total,
      mode: p.mode,
      reused,
      namesMode: useHook ? "hook" : "font",
      decodeModes: modes,
      reachedEnd,
      hookStats,
      /*
       * 并发状态显式可见(v1.5.1): 调用方传了 tabs>1 却走了串行, 必须能在响应里看到
       * 为什么 —— 静默降级正是 v1.5.0 之前被诟病的毛病。
       */
      extra: p.tabs > 1
        ? {
            concurrency: {
              mode: "sequential",
              tabs: 1,
              requested_tabs: p.tabs,
              page_url_mode: pageUrlMode,
              degraded: true,
              degrade_reason:
                degrade ||
                (p.names === "hook"
                  ? "hook_mode_incompatible"
                  : (pageUrlMode === "no" ? "page_url_not_accepted" : "page_url_unsupported")),
              hint: DEGRADE_HINT[degrade] || undefined,
            },
          }
        : undefined,
    });
    if (p.mode === "cheapest") {
      log("browser", `ysbang cheapest pages=${pagesFetched} scanned=${out.scanned}/${total} complete=${out.complete} min=${out.price_min} requests=${reqCounter}`);
    } else {
      log("browser", `ysbang full ok pages=${pagesFetched} n=${out.count} requests=${reqCounter}`);
    }
    return out;
  } finally {
    // 复用的标签是用户自己的, 不关; 自己开出来的关掉
    if (reused) {
      page.keepOpen = true;
    }
    busyTabs.delete(page.tabId); // 释放占用, 让排队中的调用可以复用它
    await closePage(page);
  }
}

/*
 * 统一入口: 熔断 -> 缓存 -> 选并发/串行 -> 写缓存。
 * 并发(页级)只对 names=font 生效: 挂钩模式每页要额外预热一次列表请求,
 * 并发会把请求数翻倍, 与抗风控目标相反。
 */
async function fetchPrices(p) {
  assertNotBlocked(p);

  if (!p.nocache) {
    const hit = cacheGet(p, p.ttl);
    if (hit) {
      const age = Math.round((Date.now() - hit.at) / 1000);
      log("info", `ysbang cache hit q=${p.q} mode=${p.mode} age=${age}s`);
      return Object.assign({}, hit.payload, {
        cached: true,
        cached_at: new Date(hit.at).toISOString(),
        cache_age_s: age,
        requests: 0,
      });
    }
  }

  reqCounter = 0; // 本次调用的页面级请求计数从零开始
  let wantParallel = p.tabs > 1 && p.names !== "hook" && pageUrlUsable();
  if (wantParallel && Date.now() < parallelBadUntil) {
    const left = Math.ceil((parallelBadUntil - Date.now()) / 60000);
    log("info", `ysbang 并发页处于冷却期(上次拿到不完整数据), 本次直接串行; 剩余 ${left} 分钟`);
    wantParallel = false;
  }

  let out;
  if (wantParallel) {
    try {
      out = await fetchParallelPages(p);
    } catch (e) {
      if (!e || !e.__ysbFallback) throw e; // 验证码/登录/超时: 正常抛, 不掩盖
      const reason = e.__ysbTabReuse
        ? "tab_reuse_extension_reused_tab"
        : (e.__ysbIncomplete
          ? "parallel_incomplete"
          : (e.__ysbPageUrlUnsupported ? "page_url_not_accepted" : "parallel_precheck_failed"));
      log("warn", `ysbang 并发页不可用, 退回串行: ${e.message}`);
      if (e.__ysbTabReuse) {
        log("warn", "ysbang 提示: 扩展把并发的新窗口判成「URL 已打开」而复用了同一标签; 需重载打过 hash 路由补丁的扩展(v1.5.1)");
      }
      out = await fetchSequential(p, { degrade: reason });
      // 降级原因同时写进日志与响应, 便于事后判断要不要继续用并发
      log("info", `ysbang degraded tabs=${p.tabs} -> sequential (${reason})`);
    }
  } else {
    out = await fetchSequential(p);
  }

  cachePut(p, out); // 完整结果入缓存, 同词在 TTL 内不再打页面
  return out;
}

/*
 * 批量询价(v1.5.0): 一次请求问多个品种。
 * ---------------------------------------------------------------------------
 * 这是「多标签并发」最实用的形态 —— 老郭一次比价通常是 5~10 个品种,
 * 逐个调接口等于把 10 次搜索串成一条长队。这里用 parallel 个标签并发跑,
 * 每个标签内部仍走串行翻页(tabs=1), 避免「外层并发 × 内层并发」把标签数炸开。
 *
 * 与单条查询共用同一个熔断状态与页级节流闸:
 *   - 任意一个品种撞到验证码 -> 立即停手, 未开始的品种不再发车(返回 aborted)
 *   - 已完成的结果照常返回, 不因为后面的失败而丢弃(部分可用优于全军覆没)
 */
async function fetchBatch(p, qs) {
  // 批量默认 2 个标签并发; 显式传 tabs=1 才串行(比如正在被风控盯着的时候)
  const parallel = Math.max(1, Math.min(p.tabs_given ? p.tabs : 2, 2));
  const queue = qs.slice();
  const results = [];
  let abort = null;
  let requests = 0;

  const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length && !abort) {
      const q = queue.shift();
      try {
        const data = await fetchPrices(Object.assign({}, p, { q, tabs: 1, nocache: p.nocache }));
        requests += data.requests || 0; // 每次 fetchPrices 会重置模块计数器, 这里累加汇总
        results.push({ q, ok: true, data });
      } catch (e) {
        results.push({ q, ok: false, error: e.message, status: e.status || null, hint: e.hint || null });
        if (e.status === 429 || e.needs_human) abort = e;
      }
    }
  });
  await Promise.all(workers);

  /*
   * 并发失败自动补救(v1.5.1, 真机实测触发):
   * 两个品种并发时, 其中一个偶发「搜索页没有渲染出商品列表」——背景窗口里的标签会被
   * 浏览器节流, 首屏 SPA 迟迟不渲染。这类失败是环境性的、非确定性的, 单跑一次往往就过,
   * 所以对失败品种串行重跑一次再收尾。验证码/登录失效不重试(重试只会加重风控)。
   */
  const retryList = [];
  if (!abort) {
    for (const r of results) {
      const src = r.error || "";
      if (!r.ok && r.status !== 429 && !/登录/.test(src)) retryList.push(r.q);
    }
  }
  if (retryList.length) {
    log("info", `ysbang batch 串行重试 ${retryList.length} 个失败品种: ${retryList.join(",")}`);
    for (const q of retryList) {
      try {
        const data = await fetchPrices(Object.assign({}, p, { q, tabs: 1, nocache: true }));
        const idx = results.findIndex((r) => r.q === q);
        const entry = { q, ok: true, data, retried: true };
        if (idx >= 0) results[idx] = entry; else results.push(entry);
        requests += data.requests || 0;
        log("info", `ysbang batch 重试成功 q=${q} n=${data.count}`);
      } catch (e) {
        const idx = results.findIndex((r) => r.q === q);
        if (idx >= 0) results[idx] = Object.assign({}, results[idx], { retried: true, retry_error: e.message });
        log("warn", `ysbang batch 重试仍失败 q=${q}: ${e.message}`);
      }
    }
  }

  // 按入参顺序返回, 便于对账
  const byQ = new Map(results.map((r) => [r.q, r]));
  const ordered = qs.map((q) => byQ.get(q) || { q, ok: false, error: "skipped" });
  const ok = ordered.filter((r) => r.ok);
  // ⚠ requests 是「各条查询自报之和」; 并发时模块级计数器会互相叠加,
  //   只能当量级参考(与串行调用对比抗风控效果时请串行跑)。

  return {
    source: "ysbang via web-to-openapi",
    fetched_at: new Date().toISOString(),
    mode: p.mode,
    parallel,
    query_count: qs.length,
    ok_count: ok.length,
    failed_count: ordered.length - ok.length,
    retried_count: ordered.filter((r) => r.retried).length,
    cached_count: ok.filter((r) => r.data && r.data.cached).length,
    aborted: !!abort,
    aborted_reason: abort ? abort.message : null,
    requests,
    results: ordered,
  };
}

module.exports = {
  id: "ysbang",
  title: "药师帮报价",
  // v1.5.0: 本站允许最多 3 个并发槽(不同查询各自一个标签), 其余站点默认 1 槽。
  // 真正的请求节奏由 pagePacer 控制, 槽位只决定「能不能同时跑」。
  concurrency: 3,
  endpoints: [
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/ysbang/price",
      tool: "ysbang_price",
      operationId: "ysbangPrice",
      summary: "药师帮批发报价(字体反爬解码 + 缓存/限页比价/验证码熔断)",
      description:
        "驱动浏览器打开药师帮(dian.ysbang.cn)按关键词采集批发报价, 价格由字体连字渲染并已在页面内还原为数字。抗风控四件套: ① 同词同参数在 ttl 内走缓存(默认 12 小时, 0 关闭), 重复查询不发任何请求; ② mode=cheapest 只扫有限页并按价格取最低 top 条(默认 3 页, 返回 complete/lowest_is_global 标明是否为全站最低); ③ 探测到可见的滑块/验证码立即熔断冷却 15 分钟, 保护登录账号; ④ 拟人节奏(随机延时 + 走入框打字 + 浏览滚动)。并发: tabs=2~3 开启页级并发(仅 names=font), 多品种询价请用 /api/v1/ysbang/batch。参数: q(必填); mode(full=全量翻页 / cheapest=取最低价); pages(页数, 0=全部, 上限 20, cheapest 默认 3); top(cheapest 返回条数, 默认 8); sort(对结果排序); include_zero; names(font/hook); tabs(1~3); ttl; nocache; reset_block。注意: 该站搜索页没有价格排序项, 每页固定约 60 条, 最低价准确度取决于扫描页数。",
      post: {
        operationId: "ysbangPricePost",
        summary: "药师帮报价(POST JSON body, 中文免 URL 编码)",
        description: "与 GET 参数相同, 改用 JSON body。中文关键词推荐用本方式。",
      },
      example: { q: "化积口服液", mode: "cheapest" },
      responses: {
        200: { description: "报价列表(count/total/price_min/price_max/requests/items)" },
        400: { description: "缺少查询词 q" },
        429: { description: "命中验证码/仍在冷却期(附 retry_after_s 与处理建议)" },
        503: { description: "需要人工登录(needs_human=true)" },
        504: { description: "页面未渲染(窗口被最小化/无结果)" },
      },
      browser: true,
      parse: parseRequest,
      run: (p) => fetchPrices(p),
      doc: {
        note:
          "药师帮批发报价。比价用 mode=cheapest(默认扫 3 页取最低价, complete=true 才是全站最低)。同词 12 小时内重复调用走缓存不发请求。被风控弹验证码时会立即停手并冷却 15 分钟, 手动过一次后带 reset_block=1 恢复。注意: 该站无价格排序, 每页约 60 条。",
        tryQuery: "/api/v1/ysbang/price?q=化积口服液&mode=cheapest",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/ysbang/price?q=%E5%8C%96%E7%A7%AF%E5%8F%A3%E6%9C%8D%E6%B6%B2&mode=cheapest"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/ysbang/price \\
  -H "Content-Type: application/json" \\
  -d '{"q":"化积口服液","mode":"cheapest"}'`,
        postNote: "中文关键词推荐 POST, body 里的中文不需要 URL 编码。比价请优先 mode=cheapest。",
        slow: true,
      },
    },
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/ysbang/batch",
      tool: "ysbang_batch_price",
      operationId: "ysbangBatchPrice",
      summary: "药师帮批量询价(多品种并发, 2 个标签并行, 共享熔断与缓存)",
      description:
        "一次请求询多个品种的批发报价。qs 支持 JSON 数组/逗号分隔/多个同名参数(单次最多 10 个)。内部用 2 个标签并发跑, 每个品种内部仍是单标签串行翻页; 所有请求共用页级节流闸, 总节奏接近单人操作。任意品种命中验证码即整体停手(aborted=true), 已完成的结果照常返回。其余参数(mode/pages/top/sort/ttl/names)与单条查询一致。",
      post: {
        operationId: "ysbangBatchPricePost",
        summary: "药师帮批量询价(POST JSON body)",
        description: "body 形如 {\"qs\":[\"化积口服液\",\"藿香正气颗粒\"],\"mode\":\"cheapest\"}。",
      },
      example: { qs: ["化积口服液", "藿香正气颗粒"], mode: "cheapest" },
      responses: {
        200: { description: "按入参顺序返回 results[{q,ok,data|error}], 带 ok_count/failed_count/aborted" },
        400: { description: "缺少 qs 或超过 10 个品种" },
        429: { description: "命中验证码/冷却期(部分结果仍会返回)" },
      },
      browser: true,
      parse: parseBatchRequest,
      run: (args) => fetchBatch(args.base, args.qs),
      doc: {
        note:
          "批量询价: 一次问多个品种, 2 个标签并发。单次上限 10 个品种。命中验证码会整体停手, 已完成的结果保留。",
        tryQuery: "/api/v1/ysbang/batch?qs=化积口服液,藿香正气颗粒&mode=cheapest",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/ysbang/batch?qs=%E5%8C%96%E7%A7%AF%E5%8F%A3%E6%9C%8D%E6%B6%B2,%E8%97%BF%E9%A6%99%E6%AD%A3%E6%B0%94%E9%A2%97%E7%B2%92&mode=cheapest"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/ysbang/batch \\
  -H "Content-Type: application/json" \\
  -d '{"qs":["化积口服液","藿香正气颗粒"],"mode":"cheapest"}'`,
        postNote: "多个品种推荐 POST 传数组, 中文无需编码。",
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "ysbang_price",
      description:
        "药师帮(dian.ysbang.cn)批发报价查询, 价格已破解字体连字反爬还原为数字。比价用 mode=cheapest(默认扫 3 页约 180 条后按价格取最低 top 条, 返回 complete/lowest_is_global 标明最低价是否为全站最低); 要全量报价用 mode=full。同词同参数在 ttl(默认 12 小时)内复用缓存, 不发请求。探测到可见的滑块验证码会立即熔断 15 分钟并返回 429。tabs=2~3 时对该次查询做页级并发(仅 names=font), 标签数不影响总请求节奏。注意该站没有价格排序项、每页固定约 60 条, 最低价的准确度取决于扫描页数(pages=0 为全量)。参数 q 必填。",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "搜索关键词, 如 化积口服液" },
          mode: { type: "string", enum: ["full", "cheapest"], description: "full=全量翻页(默认); cheapest=限页扫描后按价格取最低 top 条(默认扫 3 页)" },
          pages: { type: "integer", minimum: 0, maximum: 20, description: "扫描页数(默认 0=全部, 上限 20); mode=cheapest 时不传则默认 3。该站每页固定约 60 条" },
          top: { type: "integer", minimum: 1, maximum: 30, description: "mode=cheapest 时返回的最低价条数(默认 8)" },
          sort: { type: "string", enum: ["price_asc", "price_desc"], description: "对结果按价格升序/降序(默认保持页面顺序)" },
          include_zero: { type: "boolean", description: "是否保留价格解码失败/为 0 的条目(默认 false 过滤掉)" },
          names: { type: "string", enum: ["font", "hook"], description: "品名来源: font=仅字体解码(默认, 快, 可并发); hook=再取解密明文覆盖品名(慢约 1 倍, 乱码更少, 不能并发)" },
          tabs: { type: "integer", minimum: 1, maximum: 3, description: "页级并发标签数(默认 1=顺序翻页); 2~3 可缩短翻页时间, 仅在 names=font 时生效" },
          ttl: { type: "integer", minimum: 0, description: "缓存有效期秒数, 默认 43200(12小时), 0=关闭缓存" },
          nocache: { type: "boolean", description: "true=本次强制重新采集, 但仍会写入缓存" },
          reset_block: { type: "boolean", description: "true=清除熔断冷却(手动过完验证码后立即恢复)" },
        },
        required: ["q"],
      },
      browser: true,
      run: (args) => fetchPrices(parseRequest(args || {})),
    },
    {
      name: "ysbang_batch_price",
      description:
        "药师帮批量询价: 一次查多个品种(qs, 单次最多 10 个), 用 2 个标签并发跑, 每个品种内部单标签串行翻页。所有请求共用页级节流闸, 总节奏接近单人操作; 任意品种命中验证码即整体停手(aborted=true), 已完成结果照常返回。比价场景优先用它: 5~10 个品种一次问完, 比逐个调用快数倍且请求总量不变。其余参数与 ysbang_price 相同。",
      inputSchema: {
        type: "object",
        properties: {
          qs: { type: "array", items: { type: "string" }, description: "品种关键词数组, 如 [\"化积口服液\",\"藿香正气颗粒\"]; 也接受逗号分隔字符串。单次最多 10 个" },
          mode: { type: "string", enum: ["full", "cheapest"], description: "full=全量翻页; cheapest=限页扫描后按价格取最低 top 条(默认)" },
          pages: { type: "integer", minimum: 0, maximum: 20, description: "每个品种扫描的页数(默认 0; cheapest 时默认 3)" },
          top: { type: "integer", minimum: 1, maximum: 30, description: "cheapest 时每个品种返回的最低价条数(默认 8)" },
          sort: { type: "string", enum: ["price_asc", "price_desc"], description: "对每个品种的结果按价格升序/降序" },
          include_zero: { type: "boolean", description: "是否保留价格解码失败/为 0 的条目(默认 false)" },
          names: { type: "string", enum: ["font", "hook"], description: "品名来源: font=仅字体解码(默认); hook=取解密明文覆盖品名(更慢)" },
          ttl: { type: "integer", minimum: 0, description: "缓存有效期秒数, 默认 43200(12 小时), 0=关闭" },
          nocache: { type: "boolean", description: "true=本次强制重新采集" },
          reset_block: { type: "boolean", description: "true=清除熔断冷却" },
        },
        required: ["qs"],
      },
      browser: true,
      run: (args) => {
        const { base, qs } = parseBatchRequest(args || {});
        return fetchBatch(base, qs);
      },
    },
  ],
};
