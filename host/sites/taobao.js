"use strict";
/*
 * 站点: 淘宝搜同款(以图搜图 / 拍立淘)
 * ---------------------------------------------------------------------------
 * 一张本地商品图 -> 找到淘宝上的同款/相似商品列表(标题/价格/店铺/销量/链接)。
 * 完整链路:
 *   进淘宝(s.taobao.com 搜索页, 有「搜同款 / 按图片搜索 / 上传图片」明入口) ->
 *   定位 <input type=file> 上传本地图片(CDP DOM.setFileInputFiles, 见 act/upload) ->
 *   点「搜索」按钮触发拍立淘(二次确认) -> 等结果页 -> 抓商品列表 -> 返回 JSON + 落 xlsx。
 *
 * 真机已跑通(2026-11-14): 上传入口是隐藏的 #image-search-custom-file-input(首页/搜索页都有);
 * 上传后弹出「按图片搜索」面板, 需再点 #image-search-upload-button 才触发搜索; 结果页 URL 是
 * s.taobao.com/?localImgKey=... (不是 /search)。商品卡片 = div[class*=doubleCard](链接在卡片外层)。
 * ⚠ 淘宝会改版/混淆 class 名, 若失效重点重校 EXTRACT_JS 与 #image-search-upload-button 两个选择器。
 *
 * ⚠ 风控限制(真机实测): 拍立淘对「程序化 DOM.setFileInputFiles 塞文件 + 冷启动标签」有反自动化限制,
 * 且高频调用会触发限流(首次能搜出几十个商品, 连续多次后点搜索不返回结果、不跳 localImgKey)。
 * 对策: ①优先复用浏览器里已打开、已登录的淘宝标签(tabId 入参); ②控制调用频率, 别连续猛刷;
 *      ③触发限流后暂停一段时间再试。这属于平台风控, 不是代码缺陷。
 *
 * ⚠ 复用标签必须导航到「不带 query 的干净首页」: 复用的标签若是上一轮结果页(URL 带 localImgKey 残留),
 * 直接 upload 会因页面不是首页而搜不出(第一张 0 条即此因)。带 ?f=xxx 只追加参数、localImgKey 仍在;
 * 只有 navigate 到 https://s.taobao.com/(不带任何 query) 才会清掉残留。searchByImage 已自动处理。
 */
const fs = require("fs");
const path = require("path");
const action = require("../lib/action");
const { openPage, closePage, needsHuman, jsEval, decodeUrlCodes, toSearchParams, truthy, sleep, callTool, dataText } = require("../lib/util");
const { writeSheet } = require("../lib/xlsx");
const { STATE_DIR } = require("../lib/config");

const HOME_URL = "https://www.taobao.com/";
const SEARCH_URL = "https://s.taobao.com/";

// 请求参数: GET 查询串 / POST JSON 统一
function parseRequest(input) {
  const sp = toSearchParams(input);
  const p = {
    image_path: (sp.get("image_path") || "").trim(),
    entry: (sp.get("entry") || "search").trim().toLowerCase(),
    tabId: sp.get("tabId") == null || sp.get("tabId") === "" ? null : parseInt(sp.get("tabId"), 10),
    wait_ms: (() => { const v = parseInt(sp.get("wait_ms"), 10); return Number.isFinite(v) && v > 0 ? v : 25000; })(),
    max_items: (() => { const v = parseInt(sp.get("max_items"), 10); return Number.isFinite(v) && v > 0 ? v : 60; })(),
    out: (sp.get("out") || "").trim(),
    no_excel: truthy(sp.get("no_excel")),
  };
  if (p.entry !== "home" && p.entry !== "search") p.entry = "search";
  if (p.tabId != null && !Number.isFinite(p.tabId)) p.tabId = null;
  return p;
}

/*
 * 结果提取(真机校准过 2026-11-14)。
 * 淘宝拍立淘结果页结构: 每个商品 = div[class*=doubleCard](卡片), 其外层才是 <a>(商品链接, 用 closest('a') 取)。
 * 关键坑: ①商品图 <img> 无 alt, 标题要从「图+标题容器」div[class*=mainPicAndDesc] 的文本取(第一个 ¥ 之前);
 *         ②价格数字被拆分带空格("¥ 18 .71"), 正则需要允许空白; ③销量有 29人付款 / 100+人付款 / 1万+人付款 多种格式。
 * 链接用字符码数组(url_c)传输, host 侧 decodeUrlCodes 还原(直返 href 会被扩展 sanitize 当查询串整块拦截)。
 */
const EXTRACT_JS = `
const enc=(s)=>{const out=[];for(let i=0;i<s.length;i++)out.push(s.charCodeAt(i));return out;};
const abs=(h)=>{if(!h)return '';if(/^https?:/.test(h))return h;if(h.indexOf('//')===0)return 'https:'+h;return h;};
const seen=new Set();const items=[];
const cards=document.querySelectorAll('div[class*="doubleCard"]');
for(let i=0;i<cards.length;i++){
  const card=cards[i];
  const a=card.closest('a'); if(!a) continue;
  const href=a.getAttribute('href')||'';
  const idm=href.match(/[?&]id=(\\d{5,})/); if(!idm) continue;
  const id=idm[1]; if(seen.has(id)) continue; seen.add(id);
  const txt=(card.innerText||'').replace(/\\s+/g,' ').trim();
  let title='';
  const desc=card.querySelector('div[class*="mainPicAndDesc"]');
  const src=(desc?desc.innerText:txt)||'';
  const pi=src.search(/[¥￥]/);
  title=(pi>0?src.slice(0,pi):src).replace(/\\s+/g,' ').trim();
  let price=null;const pm=txt.match(/[¥￥]\\s*([0-9]+(?:\\s*\\.\\s*[0-9]{1,2})?)/);if(pm)price=pm[1].replace(/\\s+/g,'');
  let sales=null;const sm=txt.match(/([0-9]+(?:\\.[0-9]+)?万?\\+?)\\s*(?:人付款|人已付款|已售|人已买)/);if(sm)sales=sm[1];
  let shop=null;const sa=card.querySelector('a[href*="shop"],a[href*="shopId"]');
  if(sa){shop=(sa.getAttribute('title')||'').trim();if(!shop)shop=(sa.innerText||'').replace(/\\s+/g,' ').trim();}
  if(shop)shop=shop.replace(/^.*?(?:回头客[0-9]+万?|\\d+年老店)\\s*/,'');
  if(!shop){const shm=txt.match(/([\\u4e00-\\u9fa5A-Za-z0-9]{2,20}(?:旗舰店|专营店|专卖店|官方店|企业店|天猫超市|大药房|个人护理|健身馆|运动馆))/);if(shm)shop=shm[1];}
  const img=card.querySelector('img');
  items.push({id:id,title:title,price:price,sales:sales,shop:shop,
    url_c:enc(abs(href)),image:(img?(img.getAttribute('src')||img.getAttribute('data-src')||''):'').slice(0,500)});
  if(items.length>=200)break;
}
const bodyText=document.body?document.body.innerText:'';
const captcha=/安全验证|验证码|操作太频繁|请拖动|滑块/.test(bodyText);
const needLogin=/login\\.taobao/.test(location.href)||/请登录|亲，请登录/.test(bodyText.slice(0,800));
return {ready:document.readyState,path:String(location.pathname||'').slice(0,120),
  count:items.length,items:items,captcha:captcha,needLogin:needLogin,bodyLen:bodyText.length};
`;

// 在上传入口点击后 / 上传前, 找「搜同款/上传图片/拍照」这类触发按钮的 ref
const ENTRY_KEYWORDS = ["上传图片", "按图片搜索", "搜同款", "图片搜索", "拍照", "相机", "以图搜"];

async function findEntryRef(tabId) {
  await action.observe({ tabId, max: 300 });
  for (const kw of ENTRY_KEYWORDS) {
    const f = await action.find({ tabId, filters: [{ field: "text", value: kw }], max: 10 });
    const list = (f.matches || []).filter((m) => m.cx != null && m.cy != null);
    if (!list.length) continue;
    const m = list.find((x) => !x.disabled) || list[0];
    return { ref: m.ref, name: m.name || kw, keyword: kw };
  }
  return null;
}

/*
 * 拿到 tabId 所在的 windowId。chrome_switch_tab 只有在收到 windowId 时才会
 * chrome.windows.update(focused:true) 把窗口带到前台——只传 tabId 时它只 tabs.update(active),
 * 窗口仍在后台/被遮挡, Chromium 会冻结不可见窗口的渲染(拍立淘点搜索不触发、结果不渲染)。
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

/*
 * 上传图片后, 淘宝会弹出「按图片搜索」面板并显示预览, 此时还不会搜索——
 * 必须再点面板底部的「搜索」按钮(#image-search-upload-button)才真正触发图片搜索跳结果页。
 * 后台标签 CDP 输入不可靠, 先切前台(带 windowId 激活窗口)再坐标点击(真输入)。
 */
async function clickImageSearch(tabId, windowId) {
  const args = { tabId };
  if (windowId != null) args.windowId = windowId;
  await callTool("chrome_switch_tab", args, 15000).catch(() => {});
  await sleep(250);
  const code = `
    var el = document.querySelector('#image-search-upload-button') || document.querySelector('div[class*="upload-button"]');
    if(!el) return { ok:false, why:'no_upload_button' };
    var r = el.getBoundingClientRect();
    if(r.width<=0||r.height<=0) return { ok:false, why:'not_visible' };
    return { ok:true, cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2) };
  `;
  const pos = await jsEval(tabId, code, { strict: true, timeoutMs: 20000 });
  if (!pos || !pos.ok) return false;
  await callTool("chrome_computer", { tabId, action: "left_click", coordinates: { x: pos.cx, y: pos.cy }, forceCdp: true }, 30000);
  return true;
}

/*
 * 关闭「按图片搜索」浮层(右上角 back-button)。不关的话浮层会一直挂着,
 * 视觉上像"卡住/上传了两遍"。用合成 click 即可(关闭按钮不依赖真鼠标), 失败不影响主流程。
 */
async function closeImagePanel(tabId) {
  const code = `
    var btn = document.querySelector('div[class*="image-search-context-wrapper"] div[class*="back-button"]');
    if(!btn) return { ok:false, why:'no_panel' };
    btn.click();
    return { ok:true };
  `;
  try { await jsEval(tabId, code, { timeoutMs: 10000 }); } catch (e) { /* ignore */ }
}

// 上传后轮询结果页
async function waitForResults(tabId, waitMs, page) {
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await jsEval(tabId, EXTRACT_JS, { maxOutputBytes: 262144 });
    if (last && last.captcha) await needsHuman(page, "淘宝安全验证(反爬)");
    if (last && last.needLogin) await needsHuman(page, "淘宝需要登录");
    if (last && Array.isArray(last.items) && last.items.length > 0) return last;
    if (last && last.bodyLen === 0) {
      const e = new Error("淘宝页面没有渲染出内容: 浏览器窗口可能被最小化/遮挡, Chromium 会冻结不可见标签的加载");
      e.status = 504;
      e.hint = "把浏览器窗口切到前台后重试; 或在 host/config.json 设 page_mode=\"window-front\"。";
      throw e;
    }
    await sleep(1200);
  }
  return last;
}

function defaultOutPath(ts) {
  return path.join(STATE_DIR, "webtoopenapi", "exports", `taobao-搜同款-${ts}.xlsx`);
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
  const homeUrl = p.entry === "home" ? HOME_URL : SEARCH_URL;
  let page;
  let tabId;
  let windowId = null;
  if (p.tabId != null) {
    tabId = p.tabId;
    page = { tabId, keepOpen: true }; // 复用调用方标签, 不自动关
    // 复用标签可能是上一轮的结果页(URL 带 localImgKey 残留)。若直接 upload, 页面不是干净首页,
    // 点搜索不会触发(真机踩过: 第一张 0 条就是这原因)。navigate 到「不带 query 的首页」能清掉残留
    // (带 ?f=xxx 只会追加参数, localImgKey 仍在); 若已是干净首页则仅激活, 无害。
    await callTool("chrome_navigate", { url: homeUrl, tabId, background: false }, 30000);
  } else {
    // 淘宝搜同款要「精确点击搜索按钮 + 等结果渲染」, 不激活窗口(focused:false)时点击/渲染不可靠(真机踩过:
    // window 模式跑完 count=0)。所以用 window-front(激活窗口, 搜完即关)。代价是会短暂抢一次焦点。
    page = await openPage(homeUrl, { siteMode: "window-front" });
    tabId = page.tabId;
    windowId = page.windowId;
  }
  // 复用标签时 page 没有 windowId, 从标签列表反查——clickImageSearch 需要它把窗口真正带到前台。
  if (windowId == null) windowId = await windowIdOf(tabId);

  try {
    // 等页面就绪(文件框出现 + 文档完成), 再额外等 SDK 绑定 change/搜索事件。
    // 固定 sleep 不可靠: 新标签首次要下载拍立淘 SDK(网络慢时 10s 都不够), 复用标签缓存后 4s 够。
    // 轮询到文件框就绪后再等 2.5s(给 SDK 绑定 change 监听), 兼顾快慢两种情况。
    const waitLimit = p.tabId == null ? 18000 : 12000;
    const readyBy = Date.now() + waitLimit;
    while (Date.now() < readyBy) {
      let st = null;
      try { st = await jsEval(tabId, `return { n: document.querySelectorAll('input[type=file]').length, ready: document.readyState }`, { timeoutMs: 8000 }); } catch (e) { /* ignore */ }
      if (st && st.n > 0 && st.ready === "complete") break;
      await sleep(700);
    }
    await sleep(2500);

    // 1) 直接尝试上传(文件输入框 #image-search-custom-file-input 已在 DOM 里, 只是隐藏)
    let up = await action.upload({
      tabId,
      file_path: p.image_path,
      settle_ms: 4000,
      timeout_ms: 60000,
    });

    // 2) 没找到文件框 -> 点上传入口(相机/搜同款/上传图片)再上传
    if (up.hint === "no_file_input") {
      const entry = await findEntryRef(tabId);
      if (!entry) {
        const e = new Error("没找到图片上传入口(搜同款/上传图片/拍照), 也没有现成的 <input type=file>; 淘宝页面结构可能改版, 需真机校准");
        e.status = 500;
        throw e;
      }
      await action.click({ tabId, ref: entry.ref, page_token: undefined, settle_ms: 2000, timeout_ms: 30000 });
      await sleep(800); // 等点击后 file input 出现
      up = await action.upload({
        tabId,
        file_path: p.image_path,
        settle_ms: 4000,
        timeout_ms: 60000,
      });
    }

    // 3) 上传仍失败(真失败 / 多个文件框未消歧) -> 如实上报
    if (up.dispatched !== true) {
      const e = new Error("图片上传失败: " + (up.note || up.stale_reason || "unknown"));
      e.status = 500;
      e.detail = up;
      throw e;
    }

    // 3.5) 上传成功后点「搜索」按钮触发图片搜索(淘宝拍立淘需二次确认)
    await sleep(600); // 等「按图片搜索」面板弹出
    const clicked = await clickImageSearch(tabId, windowId);
    if (!clicked) {
      const e = new Error("图片已上传, 但没找到「搜索」按钮(#image-search-upload-button)来触发搜索; 淘宝页面结构可能改版, 需真机校准");
      e.status = 500;
      throw e;
    }

    // 4) 等结果
    const raw = await waitForResults(tabId, p.wait_ms, page);

    // 结果已抓, 关掉「按图片搜索」浮层(否则一直挂着像卡住)
    await closeImagePanel(tabId);

    const items = (raw && raw.items ? raw.items : [])
      .slice(0, p.max_items)
      .map((it) => ({
        id: it.id || null,
        title: it.title || "",
        price: it.price != null ? parseFloat(it.price) : null,
        price_raw: it.price != null ? "¥" + it.price : null,
        shop: it.shop || null,
        sales: it.sales || null,
        url: decodeUrlCodes(it.url_c),
        image: it.image || "",
      }));

    const result = {
      source: "taobao via web-to-openapi",
      fetched_at: new Date().toISOString(),
      image_path: p.image_path,
      entry: p.entry,
      result_path: (raw && raw.path) || null,
      count: items.length,
      items,
      uploaded: up && up.dispatched === true,
      upload_selector: up && up.target ? up.target.selector : null,
    };

    // 5) 落 Excel
    if (!p.no_excel) {
      const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
      const outFile = p.out || defaultOutPath(ts);
      try {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        writeSheet({
          file: outFile,
          sheet: "淘宝搜同款",
          header: ["序号", "标题", "价格(元)", "店铺", "销量", "商品ID", "链接"],
          rows: items.map((it, i) => [i + 1, it.title, it.price, it.shop || "", it.sales || "", it.id || "", it.url]),
        });
        result.file = outFile;
      } catch (e) {
        result.file = null;
        result.excel_error = String(e.message || e);
      }
    }

    result.calibration_hint =
      "淘宝结果页 DOM 会随改版变化, 提取字段(尤其店铺/销量)为多策略兜底, 建议首次真机跑通后按实际结构微调 EXTRACT_JS。";
    return result;
  } finally {
    await closePage(page); // keepOpen 的复用标签不会被关
  }
}

module.exports = {
  id: "taobao",
  title: "淘宝搜同款(以图搜图)",
  concurrency: 1,
  endpoints: [
    {
      method: "POST",
      methods: ["POST", "GET"],
      path: "/api/v1/taobao/search-by-image",
      tool: "taobao_search_by_image",
      operationId: "taobaoSearchByImage",
      summary: "淘宝以图搜同款(上传本地图片 -> 商品列表)",
      description:
        "给一张本地商品图, 找到淘宝上的同款/相似商品列表(标题/价格/店铺/销量/链接), 返回 JSON 并落 xlsx。参数: image_path(本地图片绝对路径, 必填); entry(search 默认 s.taobao.com 搜索页 / home 首页); tabId(复用已打开的淘宝页); wait_ms(等结果上限, 默认 25000); max_items(默认 60); out(xlsx 输出路径, 默认 %LOCALAPPDATA%\\webtoopenapi\\exports); no_excel(true 跳过落表)。复用你浏览器里的淘宝登录态, 遇登录/验证码会把页面切到前台。",
      example: { image_path: "D:/产品图.jpg" },
      responses: { 200: { description: "商品列表 JSON + xlsx 路径" }, 400: { description: "图片路径缺失/不存在" }, 500: { description: "上传失败/未登录/反爬/结构变化" } },
      browser: true,
      parse: parseRequest,
      run: searchByImage,
      doc: {
        note: "淘宝以图搜同款。给本地图片绝对路径, 自动 进淘宝 → 上传 → 抓同款商品列表(JSON + xlsx)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/taobao/search-by-image \\
  -H "Content-Type: application/json" \\
  -d '{"image_path":"D:/产品图.jpg"}'`,
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "taobao_search_by_image",
      description:
        "淘宝以图搜同款: 给一张本地商品图(绝对路径), 找到淘宝同款/相似商品列表(标题/价格/店铺/销量/链接), 返回 JSON 并落 xlsx。链路: 进 s.taobao.com 搜索页 → 定位 <input type=file> 上传(CDP DOM.setFileInputFiles) → 等结果页 → 抓列表。复用你浏览器里的淘宝登录态; 遇登录/验证码会把页面切到前台。entry=search(默认)/home; tabId 可复用已开的淘宝页; out 指定 xlsx 路径(默认写 %LOCALAPPDATA%\\webtoopenapi\\exports); no_excel=true 只回 JSON。",
      inputSchema: {
        type: "object",
        properties: {
          image_path: { type: "string", description: "本地商品图片绝对路径(如 D:/产品图.jpg), 必填" },
          entry: { type: "string", enum: ["search", "home"], description: "入口页: search=s.taobao.com 搜索页(默认, 有搜同款/上传图片明入口) / home=淘宝首页" },
          tabId: { type: "integer", description: "复用已打开的淘宝标签页 id(可选)" },
          wait_ms: { type: "integer", minimum: 5000, description: "等结果页上限(毫秒, 默认 25000)" },
          max_items: { type: "integer", minimum: 1, maximum: 200, description: "最多返回多少条(默认 60)" },
          out: { type: "string", description: "xlsx 输出绝对路径(可选, 默认 %LOCALAPPDATA%\\webtoopenapi\\exports\\taobao-搜同款-时间戳.xlsx)" },
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
