// 药师帮(dian.ysbang.cn) 解密数据挂钩脚本
// ---------------------------------------------------------------------------
// 本文件不作为 Node 模块 require, 由 sites/ysbang.js 以纯文本读取后注入页面执行
// (chrome_javascript 的函数体上下文, 末尾 return 即结果)。
// __YSB_MODE__ 由 host 侧替换为 "install" 或 "extract"。
//
// 背景(2026-10-23 实测):
//   接口 getWholesaleList 返回密文 {i:true, o:"<base64 密文 36KB>"}, 前端 JS 解密后
//   JSON.parse 成明文对象再渲染。所以:
//     - 直接调接口 => 拿到密文, 无解
//     - 读 DOM     => 价格是 ysb-din-bold 连字乱码, 品名遇促销变体字体也会乱码(~5%)
//     - 挂钩 JSON.parse => 拿到解密后的明文对象, 品名/价格/厂家/商家 100% 明文
//
// ⚠ 关键约束: chrome_javascript 在**隔离世界(ISOLATED world)** 执行, 直接包
//   window.JSON.parse 只能改隔离世界自己的, 拦不到页面自己的解析(Vue 内部对象
//   __vue_app__ 也不可见)。因此走「内联 script 注入主世界 + 隐藏节点回传」:
//     install: 往 DOM 里注入 <script>, 让挂钩跑在主世界; 主世界把捕获到的解密对象
//              JSON 写进 <script type="text/plain" id="__ysb_cap">
//     extract: 隔离世界读该节点的 textContent -> JSON.parse -> 映射字段 -> 返回对象
//   已实测该站 CSP 不拦内联脚本注入。
//
// 用法顺序不能反: install -> 触发一次列表请求(翻页/换词) -> extract
//
// 约束(与 ysbang-decode.js 相同):
//   - 不返回 location.href / hash / 查询串 -> 扩展侧会整块脱敏
//   - 返回对象而不是 JSON 字符串 -> 单字符串有 10KB 截断
//   - 不返回图片/外链 URL 字段(drugimageurl 等), 既无用又容易被脱敏拦截
//
// v1.5.0 捕获源选择重做(对照 Tencent/BrowserSkill 的「歧义即报错 + provenance」):
//   旧实现的四个问题都会静默出错, 只能靠 host 端对齐率事后兜底:
//     ① 主世界只写「最近一次通过 m>=10 门槛」的响应 -> 末页(不足 10 条)永远抓不到
//     ② 单节点覆盖写: 晚到的小响应会把主列表盖掉
//     ③ 页码戳只有 page=, 换搜索词/换排序但 hash 未变时旧数据照样过戳
//     ④ 回传里没有「这是哪次响应」的痕迹, 对齐失败只能盲重试
//   现在的做法:
//     ① 主世界保留最近 6 次捕获的环形缓冲, 以 (页码 + 关键词) 为分组键,
//        组内取「商品数组最长」的那次写回传节点 —— 小响应盖不掉主列表, 且取消了
//        10 条硬门槛(末页照样采)
//     ② 回传节点带 seq / 捕获时间 / 主列表长度 / 页码 / 关键词戳 = provenance
//     ③ extract 做「页码 + 关键词」双戳校验, 对不上就明确报 reason
//     ④ 候选数组长度接近时判 ambiguous(歧义), 交 host 放弃合并, 而不是静默挑一个
// ---------------------------------------------------------------------------
const MODE = "__YSB_MODE__";

const CAP_NODE_ID = "__ysb_cap";

// 主世界挂钩源码(注入 <script> 后执行)。只放最小逻辑: 捕获 + 选主列表 + 写隐藏节点。
const MAIN_HOOK_SRC = [
  "(function(){",
  "  document.documentElement.setAttribute('data-ysb-hook','1');",
  "  if (window.__YSB_HOOK) return;",
  "  window.__YSB_CAP = [];   // 兼容旧探针的计数",
  "  window.__YSB_RING = [];  // 环形缓冲: {seq,page,q,len,at,data}",
  "  window.__YSB_SEQ = 0;",
  "  var orig = JSON.parse;",
  "  function isGoods(r){",
  "    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;",
  "    if (Array.isArray(r.wholesales)) return true;",
  "    if (r.sampleSackWs || r.inwares || r.similarWholesale) return true;",
  "    return false;",
  "  }",
  "  // 当前 hash 里的页码与关键词 —— 捕获那一刻就记下来, extract 拿来对戳",
  "  function hashMeta(){",
  "    var h = '';",
  "    try { h = decodeURIComponent(location.hash || ''); } catch (e) { h = ''; }",
  "    var pm = h.match(/[?&]page=(\\d+)/);",
  "    var qm = h.match(/[?&]searchkey=([^&]*)/);",
  "    return { page: pm ? +pm[1] : 0, q: qm ? qm[1] : '' };",
  "  }",
  "  // 主列表长度: 遍历所有「商品数组」候选取最长(键名不固定: wholesales / 其它)",
  "  function mainLen(r){",
  "    var m = 0;",
  "    (function scan(o, d) {",
  "      if (!o || typeof o !== 'object' || d > 5) return;",
  "      if (Array.isArray(o)) {",
  "        if (o.length > m && o[0] && typeof o[0] === 'object' && 'wholesaleid' in o[0]) m = o.length;",
  "        for (var i = 0; i < o.length && i < 3; i++) scan(o[i], d + 1);",
  "        return;",
  "      }",
  "      for (var k in o) scan(o[k], d + 1);",
  "    })(r, 0);",
  "    return m;",
  "  }",
  "  JSON.parse = function(){",
  "    var r = orig.apply(this, arguments);",
  "    try {",
  "      if (isGoods(r)) {",
  "        var meta = hashMeta();",
  "        var len = mainLen(r);",
  "        window.__YSB_CAP.push(r);",
  "        if (window.__YSB_CAP.length > 8) window.__YSB_CAP.shift();",
  "        window.__YSB_RING.push({",
  "          seq: (window.__YSB_SEQ = (window.__YSB_SEQ || 0) + 1),",
  "          page: meta.page, q: meta.q, len: len, at: Date.now(), data: r",
  "        });",
  "        if (window.__YSB_RING.length > 6) window.__YSB_RING.shift();",
  "        // 同页同词里取主列表最长的一次; 长度相同取更新的 seq。",
  "        // 这样晚到的推荐/秒杀小响应不会覆盖主列表, 换页也不会把上一页写成当前页。",
  "        var best = null;",
  "        for (var i = 0; i < window.__YSB_RING.length; i++) {",
  "          var c = window.__YSB_RING[i];",
  "          if (c.page !== meta.page || c.q !== meta.q) continue;",
  "          if (!best || c.len > best.len || (c.len === best.len && c.seq > best.seq)) best = c;",
  "        }",
  "        if (!best) return r;",
  "        var n = document.getElementById('" + CAP_NODE_ID + "');",
  "        if (!n) {",
  "          n = document.createElement('script');",
  "          n.type = 'text/plain';",
  "          n.id = '" + CAP_NODE_ID + "';",
  "          n.style.display = 'none';",
  "          (document.body || document.documentElement).appendChild(n);",
  "        }",
  "        n.textContent = JSON.stringify(best.data);",
  "        var de = document.documentElement;",
  "        de.setAttribute('data-ysb-page', String(best.page));",
  "        de.setAttribute('data-ysb-q', best.q);",
  "        de.setAttribute('data-ysb-seq', String(best.seq));",
  "        de.setAttribute('data-ysb-time', String(best.at));",
  "        de.setAttribute('data-ysb-len', String(best.len));",
  "        de.setAttribute('data-ysb-cap', String(window.__YSB_CAP.length));",
  "      }",
  "    } catch (e) {}",
  "    return r;",
  "  };",
  "  window.__YSB_HOOK = true;",
  "})();",
].join("\n");

if (MODE === "install") {
  // 注入主世界挂钩(幂等: 主世界自己会判断 __YSB_HOOK)
  const s = document.createElement("script");
  s.textContent = MAIN_HOOK_SRC;
  document.documentElement.appendChild(s);
  s.remove();

  const hooked = document.documentElement.getAttribute("data-ysb-hook") === "1";
  const cap = document.documentElement.getAttribute("data-ysb-cap") || "0";
  return { ok: hooked, hooked: hooked, cap: +cap };
}

// ---------------------------------------------------------------------------
// extract: 读隐藏节点里的最新一次解密数据并映射字段
// ---------------------------------------------------------------------------
const AMBIG_RATIO = 0.8;   // 次长候选 >= 最长候选的 80% 视为「分不清主列表」
const SHORT_LIST = 10;     // 主列表少于这个条数只打 warning, 不再拒采

function attr(name) {
  return document.documentElement.getAttribute(name);
}
function numAttr(name) {
  const v = attr(name);
  return v == null || v === "" ? null : +v;
}

function readPayload() {
  const n = document.getElementById(CAP_NODE_ID);
  if (!n || !n.textContent) return null;
  try {
    return JSON.parse(n.textContent); // 隔离世界的 JSON.parse, 不经过主世界挂钩
  } catch (e) {
    return null;
  }
}

/*
 * 收集所有「商品数组」候选并按长度降序。
 * 该站不同入口/版本的响应结构不一致: 有的顶层是 wholesales, 有的把主列表放在
 * 别的键下, 同时还附带秒杀/推荐等小数组。旧做法直接取最长 —— 一旦推荐数组
 * 更长就会静默错位; 现在把候选连同长度一起交出去, 由 host 判歧义。
 */
function collectCandidates(obj) {
  const cands = [];
  function pushArr(arr, key) {
    if (!Array.isArray(arr) || !arr.length) return;
    if (!arr[0] || typeof arr[0] !== "object" || !("wholesaleid" in arr[0])) return;
    cands.push({ len: arr.length, key: key || "(root)", items: arr });
  }
  if (obj && Array.isArray(obj.wholesales)) pushArr(obj.wholesales, "wholesales");
  (function walk(o, depth, key) {
    if (!o || typeof o !== "object" || depth > 6) return;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) walk(o[i], depth + 1, key);
      return;
    }
    for (const k in o) {
      const v = o[k];
      if (Array.isArray(v)) pushArr(v, k);
      else if (v && typeof v === "object") walk(v, depth + 1, k);
    }
  })(obj, 0, "");

  // 同一数组被嵌套引用两次时去重(按长度 + 首条 id)
  const seen = new Set();
  const uniq = [];
  for (const c of cands) {
    const sig = c.len + ":" + String((c.items[0] && c.items[0].wholesaleid) || "");
    if (seen.has(sig)) continue;
    seen.add(sig);
    uniq.push(c);
  }
  uniq.sort((a, b) => b.len - a.len);
  return uniq;
}

// "15盒【+3元运费】包邮 牧霖 三七伤药片12片*2板" -> { prefix, moq, boxes, name }
const MOQ_RE = /^(\d+)\s*(盒|袋|包|小袋|瓶|支|只|片|个)\s*(【[^】]*】)?\s*(起购|包邮)?\s*/;
function splitDrugname(s) {
  const t = String(s || "").trim();
  const m = t.match(MOQ_RE);
  if (!m) return { prefix: "", moq: "", boxes: "", name: t };
  return {
    prefix: t.slice(0, m[0].length).trim(),
    moq: m[4] === "起购" ? m[1] + m[2] : "",
    boxes: m[4] === "包邮" ? m[1] + m[2] : "",
    name: t.slice(m[0].length).trim(),
  };
}

function money(v) {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/*
 * 只输出「文本类」字段, 不输出价格。
 *
 * 原因(实测): 主列表这版接口的价格不是数字, 而是 goodsPrice.priceShown 渲染片段,
 * 其 text/decimalText 是字体密文字符; 扩展的响应脱敏器会把这类高熵字符串整块替换成
 * [BLOCKED: Base64 encoded data] —— 密文出不了页面, 也就解不了。
 * 价格继续交给 ysbang-decode.js 的 canvas 字形匹配(实测 100% 可解),
 * 挂钩只负责它独有的价值: 品名/厂家/商家/规格/有效期这些纯明文字段。
 */
function mapItem(it, page) {
  const sp = splitDrugname(it.drugname);
  const name = String(it.cn_name || "").trim() || sp.name;
  return {
    name: name,
    factory: String(it.manufacturer || "").trim(),
    warehouse: String(it.warehouseName || "").trim(),
    shop: String(it.provider_name || it.abbreviation || "").trim(),
    spec: String(it.specification || "").trim(),
    brand: String(it.brand || "").trim(),
    moq: it.minamount ? String(it.minamount) + String(it.unit || "") : sp.moq,
    free_ship_boxes: sp.boxes,
    free_ship_floor: it.delivery_floor ? String(it.delivery_floor) : "",
    expiry: String(it.valid_date || "").trim(),
    wholesaleid: it.wholesaleid || null,
    page: page,
  };
}

// ---- 当前页面 hash 里的页码与关键词(只在本函数内比较, 不外泄原值) ----
let hash = "";
try { hash = decodeURIComponent(location.hash || ""); } catch (e) { hash = ""; }
const pageM = hash.match(/[?&]page=(\d+)/);
const qM = hash.match(/[?&]searchkey=([^&]*)/);
const page = pageM ? +pageM[1] : null;
const q = qM ? qM[1] : "";

// ---- provenance: 这次回传的数据是哪一次捕获的 ----
const seq = numAttr("data-ysb-seq");
const capturedAt = numAttr("data-ysb-time");
const stampPage = numAttr("data-ysb-page");
const stampQ = attr("data-ysb-q");
const stampLen = numAttr("data-ysb-len");

const payload = readPayload();
const cands = payload ? collectCandidates(payload) : [];

// 歧义判定: 次长候选与最长候选长度接近 => 分不清谁是主列表, 不猜
const ambiguous = cands.length > 1 && cands[1].len >= cands[0].len * AMBIG_RATIO;

let reason = null;
if (!payload || !cands.length) reason = "no_capture";
else if (stampPage != null && page != null && stampPage !== page) reason = "page_mismatch";
else if (stampQ && q && stampQ !== q) reason = "query_mismatch";
else if (ambiguous) reason = "ambiguous";

const raw = reason ? [] : cands[0].items;
const items = raw.map(function (it) { return mapItem(it, page); });

const warnings = [];
if (!reason && items.length && items.length < SHORT_LIST) warnings.push("main_list_short");
if (reason === "page_mismatch") warnings.push("stamp_page_mismatch");
if (reason === "ambiguous") warnings.push("ambiguous_main_list");

const bodyText = document.body.innerText || "";
const totalM = bodyText.match(/共\s*([\d,]+)\s*条/);
const hooked = document.documentElement.getAttribute("data-ysb-hook") === "1";

return {
  hasList: !reason && items.length > 0,
  via: "hook",
  hooked: hooked,
  // 捕获源选择的结论: null=可用; 其余是明确的失败原因(host 据此决定要不要重试)
  reason: reason,
  page: page,
  // 只回「戳对上了没有」, 不回关键词原文(扩展侧会脱敏查询串)
  stamp: {
    seq: seq,
    page: stampPage,
    page_match: stampPage == null || page == null ? null : stampPage === page,
    q_match: stampQ && q ? stampQ === q : null,
    age_ms: capturedAt == null ? null : Math.max(0, Date.now() - capturedAt),
    main_len: stampLen,
  },
  candidates: cands.slice(0, 3).map(function (c) { return { key: c.key, len: c.len }; }),
  warnings: warnings,
  capCount: numAttr("data-ysb-cap") || 0,
  totalPage: payload && payload.totalPage ? +payload.totalPage : null,
  total: totalM ? +String(totalM[1]).replace(/,/g, "") : null,
  ready: document.readyState,
  bodyLen: bodyText.length,
  needLogin: /请先登录|登录后查看|登录已失效/.test(bodyText.slice(0, 3000)),
  count: items.length,
  items: items,
};
