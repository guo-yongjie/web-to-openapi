"use strict";
/*
 * 站点: 1688 以图搜款(以图搜货)
 * ---------------------------------------------------------------------------
 * 一张本地商品图 -> 找到 1688 上的同款/相似货源(标题/价格/销量/起订量/店铺/链接)。
 * 完整链路:
 *   进 1688 首页(www.1688.com) -> 定位搜索框内「以图搜款」按钮(内含透明 <input type=file>) ->
 *   上传本地图片(CDP DOM.setFileInputFiles) -> 弹出「以图搜款」面板(显示「已上传N张图」+ 预览 + 搜索按钮) ->
 *   点面板「搜索」按钮 -> 结果在新标签页打开(air.1688.com/kapp/1688-search/pc-image-search) ->
 *   抓货源列表 -> 返回 JSON + 落 xlsx。
 *
 * 真机已跑通(2026-11-15): 用海氏海诺腕关节固定器主图, 一次拿到 60 条货源(识别为
 * 「腕关节固定器 运动护具用品」类目, 标题/价格/销量/起订量/店铺全部正确)。
 *
 * 与淘宝拍立淘、京东搜同款的关键差异(真机校准):
 *   ① 上传入口不是隐藏文件框, 而是一个「透明 file input 覆盖在按钮上」:
 *      div[class*=imageSearchBtn] 里同时有相机 svg + 「以图搜款」文案 + input[type=file]
 *      (class 含 overlay--hash, display:block, 约 144x56, 盖住整个按钮)。首页只有这一个文件框,
 *      所以直接 `input[type=file]` 直传即可, 无需先点相机。
 *   ② 上传后弹的是「以图搜款」面板 div[class*=imageSearchPopover], 里面 span[class*=count]
 *      显示「已上传N张图」, 底部 button[class*=action] 文本「搜索」——必须点它才真正触发搜索。
 *   ③ 点搜索后是「新开标签页」跳转(不是当前页跳转, 也不是 SPA):
 *      air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&imageId=...,
 *      所以要轮询 get_windows_and_tabs 抓那个新标签再提取。
 *   ④ 结果页商品卡片 = div[class*=searchOfferWrapper](整页约 60 条), 字段:
 *      title=div[class*=titleText]; price=div[class*=priceItem](内文「¥5.61」);
 *      shop=div[class*=shopName]; 销量/起订量从卡片 innerText 正则取(「5.1万+件」「3件起批」);
 *      offerId 藏在 span[data-extra] 的 JSON 里 {"offerId":733028524461},
 *      链接 host 侧拼 https://detail.1688.com/offer/{offerId}.html(不回传 URL 避 sanitize)。
 *
 * ⚠ 1688 前端是 CSS Modules(class 名带 --hash 后缀, 改版会变), 若失效重点重校:
 *   EXTRACT_JS 的选择器、FILE_INPUT_SELECTOR、POPOVER/SEARCH 按钮选择器。
 * ⚠ 风控: 与淘宝拍立淘/京东搜同款同类, 对程序化上传 + 高频调用有反自动化限制,
 *   连续猛刷可能触发限流。对策: ①复用已登录的 1688 标签(tabId 入参); ②控频; ③限流后暂停再试。
 */
const fs = require("fs");
const path = require("path");
const { openPage, closePage, closeTab, needsHuman, jsEval, toSearchParams, truthy, sleep, callTool, dataText } = require("../lib/util");
const { writeSheet } = require("../lib/xlsx");
const { STATE_DIR } = require("../lib/config");

const HOME_URL = "https://www.1688.com/";
// 结果页新标签的 URL 特征(path 含 pc-image-search), 用于轮询识别结果标签
const RESULT_URL_MARK = "pc-image-search";

// 真机校准(2026-11-15)的 selector
const FILE_INPUT_SELECTOR = "input[type=file]"; // 首页唯一文件框(盖在「以图搜款」按钮上的透明框)
const POPOVER_SELECTOR = "div[class*=imageSearchPopover]"; // 上传后弹出的「以图搜款」面板
const SEARCH_BTN_SELECTOR = "div[class*=imageSearchPopover] button[class*=action]"; // 面板内「搜索」按钮

// 请求参数: GET 查询串 / POST JSON 统一
function parseRequest(input) {
  const sp = toSearchParams(input);
  const p = {
    image_path: (sp.get("image_path") || "").trim(),
    tabId: sp.get("tabId") == null || sp.get("tabId") === "" ? null : parseInt(sp.get("tabId"), 10),
    wait_ms: (() => { const v = parseInt(sp.get("wait_ms"), 10); return Number.isFinite(v) && v > 0 ? v : 25000; })(),
    max_items: (() => { const v = parseInt(sp.get("max_items"), 10); return Number.isFinite(v) && v > 0 ? v : 60; })(),
    out: (sp.get("out") || "").trim(),
    no_excel: truthy(sp.get("no_excel")),
  };
  if (p.tabId != null && !Number.isFinite(p.tabId)) p.tabId = null;
  return p;
}

/*
 * 结果提取(真机校准过 2026-11-15)。
 * 1688 图片搜索结果页: 每个货源 = div[class*=searchOfferWrapper]。
 * 关键坑: ①offerId 不在 href 里(卡片无 <a> 到商品详情), 藏在 span[data-extra] 的 JSON {"offerId":xxx};
 *         ②价格分三块渲染(¥ / 整数 / 小数), 直接取 priceItem 的 innerText 拼回「¥5.61」;
 *         ③销量有「5.1万+件/4100+件/10万+件/1件」多种格式, 起订量「3件起批/1件起批」——
 *           用「件(?!起)」负向前瞻区分销量与起订量(否则「1件起批」会被误读成销量 1 件);
 *         ④商品图在 img[class*=mainImg].src 直接有值(非懒加载), 截断 500 字符。
 * offerId 拼链接在 host 侧做(不回传 URL, 避免触发扩展 query-string sanitize)。
 */
const EXTRACT_JS = `
const cards=document.querySelectorAll('div[class*=searchOfferWrapper]');
const items=[];
for(let i=0;i<cards.length && items.length<200;i++){
  const c=cards[i];
  let offerId='';
  const extra=c.querySelector('[data-extra]');
  if(extra){ const em=String(extra.getAttribute('data-extra')||'').match(/"offerId"\\s*:\\s*(\\d+)/); if(em) offerId=em[1]; }
  if(!offerId){ const hm=(c.outerHTML||'').match(/offer-?[iI]d[^0-9]{0,4}(\\d{8,})/); if(hm) offerId=hm[1]; }
  let title='';
  const t=c.querySelector('div[class*=titleText]');
  if(t) title=(t.innerText||'').replace(/\\s+/g,' ').trim();
  let price=null;
  const pe=c.querySelector('div[class*=priceItem]');
  if(pe){ const pm=(pe.innerText||'').replace(/\\s+/g,'').match(/([0-9]+(?:\\.[0-9]{1,2})?)/); if(pm) price=pm[1]; }
  let shop='';
  const se=c.querySelector('div[class*=shopName]');
  if(se) shop=(se.innerText||'').replace(/\\s+/g,' ').trim();
  const txt=(c.innerText||'').replace(/\\s+/g,' ');
  let sales=null; const sm=txt.match(/([0-9]+(?:\\.[0-9]+)?万?\\+?)件(?!起)/); if(sm) sales=sm[1]+'件';
  let moq=null; const mm=txt.match(/([0-9]+(?:\\.[0-9]+)?)件起批/); if(mm) moq=mm[1]+'件起批';
  const img=c.querySelector('img[class*=mainImg]');
  items.push({offerId:offerId,title:title,price:price,shop:shop,sales:sales,moq:moq,
    image:(img?(img.getAttribute('src')||img.getAttribute('data-src')||''):'').slice(0,500)});
}
const bodyText=document.body?document.body.innerText:'';
const captcha=/安全验证|验证码|操作太频繁|请拖动|滑块|请完成验证/.test(bodyText);
const needLogin=/login\\.1688|passport\\.1688/.test(location.href)||/请登录|登录后/.test(bodyText.slice(0,800));
return {ready:document.readyState,path:String(location.pathname||'').slice(0,120),
  count:items.length,items:items,captcha:captcha,needLogin:needLogin,bodyLen:bodyText.length};
`;

/*
 * 拿到 tabId 所在的 windowId。chrome_switch_tab 只有在收到 windowId 时才会把窗口带到前台,
 * 后台/被遮挡窗口会被 Chromium 冻结渲染(点搜索不触发), 所以点击前必须切前台。
 */
async function windowIdOf(tabId) {
  try {
    const data = await callTool("get_windows_and_tabs", {}, 15000);
    const parsed = JSON.parse(dataText(data));
    for (const w of parsed.windows || []) {
      if ((w.tabs || []).some((t) => t.tabId === tabId)) return w.windowId;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/*
 * 上传图片。1688 首页文件框 id/name 都为空, 但首页只有这一个 input[type=file],
 * 直接用 selector 直传(零歧义)。走 CDP DOM.setFileInputFiles(chrome_upload_file), 不需要前台。
 */
async function uploadImage(tabId, imagePath) {
  const data = await callTool("chrome_upload_file", { tabId, selector: FILE_INPUT_SELECTOR, filePath: imagePath }, 60000);
  const parsed = safeParse(dataText(data));
  if (parsed && parsed.success === true) return { dispatched: true, fileCount: parsed.fileCount || 0 };
  return { dispatched: false, error: String(dataText(data)).slice(0, 200) };
}

/*
 * 点面板内的「搜索」按钮触发图片搜索(1688 需二次确认)。
 * 先切前台(带 windowId 激活窗口), 再 JS 定位中心坐标 + chrome_computer 真输入坐标点击。
 * 真机验证: 该按钮合成 click(el.click()) 也能触发(开新标签), 但坐标真点击对改版更稳, 故坐标优先、JS 兜底。
 */
async function clickSearch(tabId, windowId) {
  const args = { tabId };
  if (windowId != null) args.windowId = windowId;
  await callTool("chrome_switch_tab", args, 15000).catch(() => {});
  await sleep(250);
  for (let i = 0; i < 6; i++) {
    const pos = await jsEval(tabId, `
      var el = document.querySelector(${JSON.stringify(SEARCH_BTN_SELECTOR)});
      if(!el) return { ok:false, why:'not_found' };
      var r = el.getBoundingClientRect();
      if(r.width<=0||r.height<=0) return { ok:false, why:'not_visible' };
      return { ok:true, cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2) };
    `, { strict: true, timeoutMs: 20000 });
    if (pos && pos.ok) {
      await callTool("chrome_computer", { tabId, action: "left_click", coordinates: { x: pos.cx, y: pos.cy }, forceCdp: true }, 30000);
      return true;
    }
    // 定位失败 -> JS 合成点击兜底
    const jsClick = await jsEval(tabId, `
      var el = document.querySelector(${JSON.stringify(SEARCH_BTN_SELECTOR)});
      if(!el) return { ok:false, why:'not_found' };
      try { el.click(); return { ok:true }; } catch(e) { return { ok:false, why:'js_click_err' }; }
    `, { strict: true, timeoutMs: 20000 });
    if (jsClick && jsClick.ok) return true;
    await sleep(300);
  }
  return false;
}

/*
 * 点搜索后, 结果在新标签页打开(air.1688.com/kapp/1688-search/pc-image-search)。
 * 轮询 get_windows_and_tabs 抓那个新标签, 返回其 tabId; 超时返回 null。
 * 注意: 结果页 URL 带 imageId 等 query, 但 get_windows_and_tabs 原样返回 URL(不 sanitize), 可直接匹配 path 特征。
 * ⚠ 只接受「点击搜索之后新建」的标签: 调用方先快照已有的 tabId 集合, 这里排除它们——
 *    否则上一轮遗留的结果页标签会被误当成本轮结果(真机批量跑会踩到)。
 */
async function findResultTab(excludeTabIds, deadline) {
  while (Date.now() < deadline) {
    try {
      const data = await callTool("get_windows_and_tabs", {}, 15000);
      const parsed = safeParse(dataText(data));
      const tabs = (parsed && parsed.windows ? parsed.windows : []).flatMap((w) => w.tabs || []);
      for (const t of tabs) {
        const url = String(t.url || "");
        if (!excludeTabIds.has(t.tabId) && url.indexOf(RESULT_URL_MARK) >= 0) return t.tabId;
      }
    } catch (e) { /* ignore, retry */ }
    await sleep(800);
  }
  return null;
}

// 快照当前所有标签页 id(用于识别「点击后新建的结果标签」)
async function snapshotTabIds() {
  const ids = new Set();
  try {
    const data = await callTool("get_windows_and_tabs", {}, 15000);
    const parsed = safeParse(dataText(data));
    const tabs = (parsed && parsed.windows ? parsed.windows : []).flatMap((w) => w.tabs || []);
    for (const t of tabs) if (t.tabId != null) ids.add(t.tabId);
  } catch (e) { /* ignore */ }
  return ids;
}

// 上传后轮询结果页
async function waitForResults(tabId, waitMs, page) {
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await jsEval(tabId, EXTRACT_JS, { maxOutputBytes: 262144 });
    if (last && last.captcha) await needsHuman(page, "1688 安全验证(反爬)");
    if (last && last.needLogin) await needsHuman(page, "1688 需要登录");
    if (last && Array.isArray(last.items) && last.items.length > 0) return last;
    await sleep(1200);
  }
  // 超时后页面完全没渲染才报 504(结果页是新标签整页跳转, bodyLen 检查放循环外, 避免误判跳转中空白)
  if (last && last.bodyLen === 0 && !(last.items && last.items.length)) {
    const e = new Error("1688 结果页没有渲染出内容: 浏览器窗口可能被最小化/遮挡, Chromium 会冻结不可见标签的加载");
    e.status = 504;
    e.hint = "把浏览器窗口切到前台后重试; 或在 host/config.json 设 page_mode=\"window-front\"。";
    throw e;
  }
  return last;
}

function defaultOutPath(ts) {
  return path.join(STATE_DIR, "webtoopenapi", "exports", `1688-搜同款-${ts}.xlsx`);
}

async function searchByImage(p) {
  if (!p.image_path) {
    const e = new Error("缺少 image_path(本地图片绝对路径)");
    e.status = 400;
    throw e;
  }
  if (!fs.existsSync(p.image_path)) {
    const e = new Error(`图片文件不存在: ${p.image_path}`);
    e.status = 400;
    throw e;
  }

  // 复用已有标签, 否则新开
  let page;
  let tabId;
  let windowId = null;
  if (p.tabId != null) {
    tabId = p.tabId;
    page = { tabId, keepOpen: true }; // 复用调用方标签, 不自动关
    // 复用标签可能是上一轮的结果页(URL 带 imageId 残留), navigate 到干净首页清残留
    await callTool("chrome_navigate", { url: HOME_URL, tabId, background: false }, 30000);
  } else {
    // 1688 搜同款要「点搜索按钮 + 等新标签结果渲染」, 后台窗口点击不可靠, 用 window-front(激活窗口)。
    // 代价是短暂抢一次焦点。宽度给 1600: 上传面板「搜索」按钮位置随窗口变, 宽一点避免被顶出视口。
    page = await openPage(HOME_URL, { siteMode: "window-front", width: 1600, height: 900 });
    tabId = page.tabId;
    windowId = page.windowId;
  }
  if (windowId == null) windowId = await windowIdOf(tabId);

  let resultTabId = null;
  try {
    // 1) 等文件框出现(搜索栏渲染完成即可上传)。1688 首页 readyState 可能长期停在 interactive,
    //    所以只看文件框是否出现, 不要卡 ready==="complete"。
    const readyBy = Date.now() + (p.tabId == null ? 18000 : 12000);
    let fileReady = false;
    let fileDiag = [];
    while (Date.now() < readyBy) {
      let st = null;
      try { st = await jsEval(tabId, `return { n: document.querySelectorAll('input[type=file]').length, ready: document.readyState }`, { timeoutMs: 8000 }); } catch (e) { fileDiag.push("err:" + e.message); }
      if (st) fileDiag.push(JSON.stringify(st));
      if (st && st.n > 0) { fileReady = true; break; }
      await sleep(700);
    }
    if (!fileReady) {
      const e = new Error("1688 首页没找到文件上传框(<input type=file>); 页面结构可能改版, 需真机校准 FILE_INPUT_SELECTOR. 诊断(最后5次): " + fileDiag.slice(-5).join(" | "));
      e.status = 500;
      throw e;
    }
    await sleep(800); // 文件框出现后再等搜索栏事件绑定稳定

    // 2) 上传图片(固定 selector 直传, 上传即触发「以图搜款」面板弹出)
    const up = await uploadImage(tabId, p.image_path);
    if (up.dispatched !== true) {
      const e = new Error("图片上传失败: " + (up.error || "unknown"));
      e.status = 500;
      throw e;
    }

    // 3) 校验上传成功: 面板弹出 + 显示「已上传N张图」(或出现预览图)。这是「上传成功」的明确判据,
    //    不是只看 CDP 回执——回执只说明文件塞进了 file input, 面板弹出才说明 change 事件被 React 处理了。
    const confirmBy = Date.now() + 8000;
    let panelConfirmed = false;
    let panelState = "";
    while (Date.now() < confirmBy) {
      const st = await jsEval(tabId, `
        var pop = document.querySelector(${JSON.stringify(POPOVER_SELECTOR)});
        var cnt = document.querySelector('div[class*=imageSearchPopover] span[class*=count]');
        var prev = document.querySelector('div[class*=imageSearchPopover] div[class*=previewList] img, div[class*=imageSearchPopover] div[class*=previewArea] img');
        var countText = cnt ? (cnt.innerText||'').replace(/\\s+/g,'').trim() : '';
        return { open: !!pop && getComputedStyle(pop).display !== 'none', count: countText, hasPreview: !!prev };
      `, { timeoutMs: 8000 });
      if (st) panelState = JSON.stringify(st);
      if (st && st.open && (st.count.indexOf("已上传") >= 0 || st.hasPreview)) { panelConfirmed = true; break; }
      await sleep(500);
    }
    if (!panelConfirmed) {
      const e = new Error("图片已塞入文件框, 但「以图搜款」面板没有确认弹出(未显示已上传N张图/预览)。诊断: " + panelState + "; 1688 结构可能改版或触发限流");
      e.status = 500;
      throw e;
    }

    // 4) 点「搜索」按钮触发搜索(开新标签)
    const clicked = await clickSearch(tabId, windowId);
    if (!clicked) {
      const e = new Error("图片已上传、面板已确认, 但没找到/点不到「搜索」按钮; 1688 页面结构可能改版, 需真机校准");
      e.status = 500;
      throw e;
    }

    // 5) 抓结果页新标签(先快照已有 tab, 只认点击后新建的标签; 兜底: 若首页自身跳到结果页 path 也算)
    const existingTabIds = await snapshotTabIds();
    existingTabIds.add(tabId); // 首页标签也排除
    const resultDeadline = Date.now() + 15000;
    resultTabId = await findResultTab(existingTabIds, resultDeadline);
    if (resultTabId == null) {
      // 兜底: 检查首页标签是否原地跳到了结果页
      const st = await jsEval(tabId, `return { path: String(location.pathname||'') }`, { timeoutMs: 8000 });
      if (st && st.path && st.path.indexOf(RESULT_URL_MARK) >= 0) resultTabId = tabId;
    }
    if (resultTabId == null) {
      const e = new Error("点「搜索」后没有出现结果页标签(air.1688.com .../pc-image-search); 可能触发 1688 限流, 或搜索按钮点击未生效, 需真机复核");
      e.status = 502;
      e.hint = "连续调用可能触发 1688 图片搜索限流, 请暂停一段时间后再试。";
      throw e;
    }

    // 6) 等结果
    const raw = await waitForResults(resultTabId, p.wait_ms, page);

    const items = (raw && raw.items ? raw.items : [])
      .slice(0, p.max_items)
      .map((it) => ({
        offer_id: it.offerId || null,
        title: it.title || "",
        price: it.price != null ? parseFloat(it.price) : null,
        price_raw: it.price != null ? "¥" + it.price : null,
        shop: it.shop || null,
        sales: it.sales || null,
        moq: it.moq || null,
        url: it.offerId ? "https://detail.1688.com/offer/" + it.offerId + ".html" : "",
        image: it.image || "",
      }));

    // 结果页没跳到 pc-image-search 且 0 条 -> 搜索没真正触发(可能限流), 明确报错而不是安静返回 0 条
    if (items.length === 0 && (raw && raw.path) && raw.path.indexOf(RESULT_URL_MARK) < 0) {
      const e = new Error("图片已上传, 但点「搜索」后结果页没有货源(未正确跳到 pc-image-search); 可能触发 1688 限流, 或搜索未生效, 需真机复核");
      e.status = 502;
      e.hint = "连续调用可能触发 1688 图片搜索限流, 请暂停一段时间后再试。";
      throw e;
    }

    const result = {
      source: "1688 via web-to-openapi",
      fetched_at: new Date().toISOString(),
      image_path: p.image_path,
      result_path: (raw && raw.path) || null,
      count: items.length,
      items,
      uploaded: up.dispatched === true,
      upload_selector: FILE_INPUT_SELECTOR,
    };

    // 7) 落 Excel
    if (!p.no_excel) {
      const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
      const outFile = p.out || defaultOutPath(ts);
      try {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        writeSheet({
          file: outFile,
          sheet: "1688搜同款",
          header: ["序号", "标题", "价格(元)", "销量", "起订量", "店铺", "offerId", "链接"],
          rows: items.map((it, i) => [i + 1, it.title, it.price, it.sales || "", it.moq || "", it.shop || "", it.offer_id || "", it.url]),
        });
        result.file = outFile;
      } catch (e) {
        result.file = null;
        result.excel_error = String(e.message || e);
      }
    }

    result.calibration_hint =
      "1688 结果页 DOM 随改版变化(CSS Modules class 名带 hash 后缀), 提取字段为多策略兜底, 建议首次真机跑通后按实际结构微调 EXTRACT_JS。当前只抓第一页(约 60 条)。";
    return result;
  } finally {
    if (resultTabId != null && resultTabId !== tabId) await closeTab(resultTabId); // 关掉结果页新标签
    await closePage(page); // keepOpen 的复用标签不会被关
  }
}

module.exports = {
  id: "ali1688",
  title: "1688 以图搜款(以图搜货)",
  concurrency: 1,
  endpoints: [
    {
      method: "POST",
      methods: ["POST", "GET"],
      path: "/api/v1/ali1688/search-by-image",
      tool: "ali1688_search_by_image",
      operationId: "ali1688SearchByImage",
      summary: "1688 以图搜款(上传本地图片 -> 货源列表)",
      description:
        "给一张本地商品图, 找到 1688 上的同款/相似货源列表(标题/价格/销量/起订量/店铺/链接), 返回 JSON 并落 xlsx。参数: image_path(本地图片绝对路径, 必填); tabId(复用已打开的 1688 页); wait_ms(等结果上限, 默认 25000); max_items(默认 60, 实际第一页约 60 条); out(xlsx 输出路径, 默认 %LOCALAPPDATA%\\webtoopenapi\\exports); no_excel(true 跳过落表)。复用你浏览器里的 1688 登录态, 遇登录/验证码会把页面切到前台。",
      example: { image_path: "D:/产品图.jpg" },
      responses: { 200: { description: "货源列表 JSON + xlsx 路径" }, 400: { description: "图片路径缺失/不存在" }, 500: { description: "上传失败/未登录/反爬/结构变化" } },
      browser: true,
      parse: parseRequest,
      run: searchByImage,
      doc: {
        note: "1688 以图搜款。给本地图片绝对路径, 自动 进 1688 首页 → 上传 → 点搜索 → 抓同款货源列表(JSON + xlsx)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/ali1688/search-by-image \\
  -H "Content-Type: application/json" \\
  -d '{"image_path":"D:/产品图.jpg"}'`,
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "ali1688_search_by_image",
      description:
        "1688 以图搜款: 给一张本地商品图(绝对路径), 找到 1688 同款/相似货源列表(标题/价格/销量/起订量/店铺/链接), 返回 JSON 并落 xlsx。链路: 进 www.1688.com 首页 → 上传(CDP DOM.setFileInputFiles, 首页唯一 file input) → 弹「以图搜款」面板 → 点「搜索」按钮 → 结果在新标签页打开 → 抓货源列表。复用你浏览器里的 1688 登录态; 遇登录/验证码会把页面切到前台。tabId 可复用已开的 1688 页; out 指定 xlsx 路径(默认写 %LOCALAPPDATA%\\webtoopenapi\\exports); no_excel=true 只回 JSON。",
      inputSchema: {
        type: "object",
        properties: {
          image_path: { type: "string", description: "本地商品图片绝对路径(如 D:/产品图.jpg), 必填" },
          tabId: { type: "integer", description: "复用已打开的 1688 标签页 id(可选)" },
          wait_ms: { type: "integer", minimum: 5000, description: "等结果页上限(毫秒, 默认 25000)" },
          max_items: { type: "integer", minimum: 1, maximum: 200, description: "最多返回多少条(默认 60, 实际第一页约 60 条)" },
          out: { type: "string", description: "xlsx 输出绝对路径(可选, 默认 %LOCALAPPDATA%\\webtoopenapi\\exports\\1688-搜同款-时间戳.xlsx)" },
          no_excel: { type: "boolean", description: "true 时只返回 JSON, 不落 Excel" },
        },
        required: ["image_path"],
        additionalProperties: false,
      },
      browser: true,
      run: (args) => searchByImage(parseRequest(args || {})),
    },
  ],
};
