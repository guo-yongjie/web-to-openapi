"use strict";
/*
 * 站点: 京东搜同款(以图搜图)
 * ---------------------------------------------------------------------------
 * 一张本地商品图 -> 找到京东上的同款/相似商品列表(标题/价格/销量/好评/店铺/链接)。
 * 完整链路:
 *   进京东首页(www.jd.com) -> 点搜索框内「图片搜索(搜同款)」相机按钮(无文字, 需 JS 定位坐标真点击) ->
 *   弹上传面板, 定位隐藏的 <input type=file id=searchImgInput> 上传本地图片(CDP DOM.setFileInputFiles) ->
 *   点面板「搜索」按钮(二次确认) -> 等结果页(search.jd.com/image) -> 抓商品列表 -> 返回 JSON + 落 xlsx。
 *
 * 真机已跑通(2026-11-15):
 *   相机按钮 = .jd_pc_search_bar_react_image_search_button(一个 div 包 img, 无 role/文本, observe 列不出);
 *   上传面板 = .jd_pc_search_bar_react_image_search_box(点击相机后 display:flex);
 *   文件框   = #searchImgInput(display:none, 但 fileInputsScript 会枚举隐藏框);
 *   搜索按钮 = .jd_pc_search_bar_react_image_search_btn(文本「搜索」, 上传后出现在面板里);
 *   结果页   = https://search.jd.com/image?imgpath=...(标题「图片搜索-京东」, path=/image);
 *   商品卡片 = [data-sku](每项含标题/¥价格/已售xx+/xx%好评/店铺), 链接固定 https://item.jd.com/{sku}.html。
 * ⚠ 京东会改版/混淆 class 名, 若失效重点重校 EXTRACT_JS 与三个 selector(相机/文件框/搜索按钮)。
 *
 * ⚠ 风控: 京东图片搜索与淘宝拍立淘同类, 对程序化上传 + 高频调用有反自动化限制,
 * 连续猛刷可能触发限流(点搜索不跳结果页)。对策: ①优先复用已登录的京东标签(tabId 入参);
 * ②控制调用频率, 别连续猛刷; ③触发限流后暂停再试。
 */
const fs = require("fs");
const path = require("path");
const action = require("../lib/action");
const { openPage, closePage, needsHuman, jsEval, toSearchParams, truthy, sleep, callTool, dataText } = require("../lib/util");
const { writeSheet } = require("../lib/xlsx");
const { STATE_DIR } = require("../lib/config");

const HOME_URL = "https://www.jd.com/";

// 京东搜索框内相机按钮 / 上传面板 / 文件框 / 二次确认搜索按钮(真机校准 2026-11-15)
const CAMERA_SELECTOR = ".jd_pc_search_bar_react_image_search_button";
const FILE_INPUT_SELECTOR = "#searchImgInput";
const SEARCH_BTN_SELECTOR = ".jd_pc_search_bar_react_image_search_btn";

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
 * 京东图片搜索结果页结构: 每个商品 = [data-sku] 卡片; sku 即商品 ID, 链接固定 item.jd.com/{sku}.html。
 * 关键坑: ①价格数字与 ¥ 分两行("¥\n70"), 正则需要允许空白; ②销量有 已售4000+ / 已售200+ 等格式;
 *         ③好评是 "99%好评"; ④店铺名以 店/药房/专营/旗舰/卖场 结尾, 用正则兜底。
 * 链接在 host 侧用 sku 拼, 不在页面回传 URL(避免触发扩展的 query-string sanitize)。
 */
const EXTRACT_JS = `
const items=[];
const cards=document.querySelectorAll('[data-sku]');
for(let i=0;i<cards.length;i++){
  const el=cards[i];
  const sku=(el.getAttribute('data-sku')||'').trim();
  if(!sku) continue;
  const raw=(el.innerText||'').replace(/\\s+/g,' ').trim();
  let title='';
  const tEl=el.querySelector('[title]');
  if(tEl && (tEl.getAttribute('title')||'').trim()) title=tEl.getAttribute('title').trim();
  if(!title){ const img=el.querySelector('img'); if(img && (img.getAttribute('alt')||'').trim()) title=img.getAttribute('alt').trim(); }
  if(!title){ const n=el.querySelector('.p-name'); if(n) title=(n.innerText||'').replace(/\\s+/g,' ').trim(); }
  if(!title) title=raw.split(/[¥￥]/)[0].replace(/\\s+/g,' ').trim().slice(0,40);
  let price=null; const pm=raw.match(/[¥￥]\\s*([0-9]+(?:\\s*\\.\\s*[0-9]{1,2})?)/); if(pm) price=pm[1].replace(/\\s+/g,'');
  let sales=null; const sm=raw.match(/已售\\s*([0-9]+(?:\\.[0-9]+)?万?\\+?)/); if(sm) sales=sm[1];
  let praise=null; const prm=raw.match(/([0-9]+)%好评/); if(prm) praise=prm[1];
  let shop=null; const shm=raw.match(/([\\u4e00-\\u9fa5A-Za-z0-9]{2,20}(?:店|药房|专营|旗舰|大药房))/); if(shm) shop=shm[1];
  const img=el.querySelector('img');
  items.push({sku:sku,title:title,price:price,sales:sales,praise:praise,shop:shop,
    image:(img?(img.getAttribute('src')||img.getAttribute('data-src')||''):'').slice(0,300)});
  if(items.length>=200) break;
}
const bodyText=document.body?document.body.innerText:'';
const captcha=/安全验证|验证码|操作太频繁|请拖动|滑块|请完成验证/.test(bodyText);
const needLogin=/passport\\.jd|login\\.jd/.test(location.href)||/请登录|登录后/.test(bodyText.slice(0,800));
return {ready:document.readyState,path:String(location.pathname||'').slice(0,120),
  count:items.length,items:items,captcha:captcha,needLogin:needLogin,bodyLen:bodyText.length};
`;

/*
 * 拿到 tabId 所在的 windowId。chrome_switch_tab 只有在收到 windowId 时才会把窗口带到前台,
 * 后台/被遮挡窗口会被 Chromium 冻结渲染(点搜索不触发、结果不渲染), 所以点击前必须切前台。
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
 * 京东的相机按钮 / 搜索按钮都是无 role 的 div, observe 列不出(known-set 拿不到 ref),
 * 所以这里 JS 定位中心坐标 + chrome_computer 真输入坐标点击(先切前台)。
 * 面板有渲染/入场动画, 定位到「不可见(尺寸 0)」或定位后坐标被动画挪走是常见情况,
 * 所以定位 + 点击做成紧耦合的重试: 每次重新取坐标立刻点, 失败(not_found/not_visible)再等 300ms 重试。
 */
async function clickSelector(tabId, windowId, selector, attempts) {
  const maxAttempts = attempts || 6;
  const args = { tabId };
  if (windowId != null) args.windowId = windowId;
  await callTool("chrome_switch_tab", args, 15000).catch(() => {});
  await sleep(250);
  for (let i = 0; i < maxAttempts; i++) {
    const code = `
      var el = document.querySelector(${JSON.stringify(selector)});
      if(!el) return { ok:false, why:'not_found' };
      var r = el.getBoundingClientRect();
      if(r.width<=0||r.height<=0) return { ok:false, why:'not_visible' };
      return { ok:true, cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2) };
    `;
    const pos = await jsEval(tabId, code, { strict: true, timeoutMs: 20000 });
    if (pos && pos.ok) {
      await callTool("chrome_computer", { tabId, action: "left_click", coordinates: { x: pos.cx, y: pos.cy }, forceCdp: true }, 30000);
      return true;
    }
    // 定位失败(尺寸 0 / 未找到) -> 降级 JS 合成点击(真机验证: 京东这两个 div 按钮 el.click() 也能触发)
    const jsClick = await jsEval(tabId, `
      var el = document.querySelector(${JSON.stringify(selector)});
      if(!el) return { ok:false, why:'not_found' };
      try { el.click(); return { ok:true }; } catch(e) { return { ok:false, why:'js_click_err' }; }
    `, { strict: true, timeoutMs: 20000 });
    if (jsClick && jsClick.ok) return true;
    await sleep(300);
  }
  return false;
}

/*
 * 上传图片。京东文件框 id 固定 #searchImgInput, 直接用 selector 直传(零歧义)。
 * 走 CDP DOM.setFileInputFiles(chrome_upload_file), 不需要前台。
 */
async function uploadImage(tabId, imagePath) {
  const data = await callTool("chrome_upload_file", { tabId, selector: FILE_INPUT_SELECTOR, filePath: imagePath }, 60000);
  const parsed = safeParse(dataText(data));
  if (parsed && parsed.success === true) return { dispatched: true, fileCount: parsed.fileCount || 0 };
  return { dispatched: false, error: String(dataText(data)).slice(0, 200) };
}

// 上传后轮询结果页
async function waitForResults(tabId, waitMs, page) {
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await jsEval(tabId, EXTRACT_JS, { maxOutputBytes: 262144 });
    if (last && last.captcha) await needsHuman(page, "京东安全验证(反爬)");
    if (last && last.needLogin) await needsHuman(page, "京东需要登录");
    if (last && Array.isArray(last.items) && last.items.length > 0) return last;
    await sleep(1200);
  }
  // 超时后页面完全没渲染才报 504。注意: 京东点搜索后是整页跳转(search.jd.com/image),
  // 跳转过程中 body 会短暂清空(与淘宝 SPA 不同), 所以 bodyLen 检查必须放在循环外, 否则会误判。
  if (last && last.bodyLen === 0 && !(last.items && last.items.length)) {
    const e = new Error("京东页面没有渲染出内容: 浏览器窗口可能被最小化/遮挡, Chromium 会冻结不可见标签的加载");
    e.status = 504;
    e.hint = "把浏览器窗口切到前台后重试; 或在 host/config.json 设 page_mode=\"window-front\"。";
    throw e;
  }
  return last;
}

function defaultOutPath(ts) {
  return path.join(STATE_DIR, "webtoopenapi", "exports", `jd-搜同款-${ts}.xlsx`);
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
    // 复用标签可能是上一轮的结果页(URL 带 imgpath 残留), navigate 到干净首页清残留
    await callTool("chrome_navigate", { url: HOME_URL, tabId, background: false }, 30000);
  } else {
    // 京东搜同款要「精确点击相机/搜索按钮 + 等结果渲染」, 后台窗口点击/渲染不可靠,
    // 用 window-front(激活窗口, 搜完即关)。代价是短暂抢一次焦点。
    // ⚠ 窗口至少 1600 宽: 京东搜索框居中, 上传面板的「搜索」按钮实测在 x≈1149-1356,
    // 默认 1280 宽会把它顶到视口外(坐标点击失效), 必须加宽。
    page = await openPage(HOME_URL, { siteMode: "window-front", width: 1600, height: 900 });
    tabId = page.tabId;
    windowId = page.windowId;
  }
  if (windowId == null) windowId = await windowIdOf(tabId);

  try {
    // 1) 等相机按钮出现(搜索栏渲染完成即可点击)。注意: 京东首页 readyState 可能长期停在
    // interactive(有持续异步资源/长连接), 所以只看相机按钮是否出现, 不要卡 ready==="complete"。
    const readyBy = Date.now() + (p.tabId == null ? 18000 : 12000);
    let camReady = false;
    let camDiag = [];
    while (Date.now() < readyBy) {
      let st = null;
      try { st = await jsEval(tabId, `return { hasCam: !!document.querySelector(${JSON.stringify(CAMERA_SELECTOR)}), ready: document.readyState }`, { timeoutMs: 8000 }); } catch (e) { camDiag.push("err:" + e.message); }
      if (st) camDiag.push(JSON.stringify(st));
      if (st && st.hasCam) { camReady = true; break; }
      await sleep(700);
    }
    if (!camReady) {
      const e = new Error("京东首页搜索框内没找到「图片搜索(搜同款)」相机按钮; 页面结构可能改版, 需真机校准 CAMERA_SELECTOR. 诊断(最后5次): " + camDiag.slice(-5).join(" | "));
      e.status = 500;
      throw e;
    }
    await sleep(800); // 相机按钮出现后再等搜索栏事件绑定稳定, 避免点了无反应

    // 2) 点相机按钮 -> 弹上传面板(file input 出现)
    const clickedCam = await clickSelector(tabId, windowId, CAMERA_SELECTOR);
    if (!clickedCam) {
      const e = new Error("点了相机按钮但没反应(定位失败或不可见); 京东页面结构可能改版");
      e.status = 500;
      throw e;
    }

    // 3) 等上传面板展开(#box 从 display:none 变 flex), 证明点相机生效。
    //    注意: #searchImgInput 是 display:none 常驻 DOM, 「等它出现」判断无效, 必须看面板是否展开。
    const BOX_JS = `(function(){ var b = document.querySelector('#box') || document.querySelector('.jd_pc_search_bar_react_image_search_box'); return !!b && getComputedStyle(b).display !== 'none'; })()`;
    const boxBy = Date.now() + 8000;
    let boxOpen = false;
    while (Date.now() < boxBy) {
      const st = await jsEval(tabId, `return { open: ${BOX_JS} }`, { timeoutMs: 8000 });
      if (st && st.open) { boxOpen = true; break; }
      await sleep(500);
    }
    if (!boxOpen) {
      // 面板没展开 -> 点相机可能没生效(合成点击/时序), 用坐标真点击再试一次
      await clickSelector(tabId, windowId, CAMERA_SELECTOR);
      await sleep(700);
      const st2 = await jsEval(tabId, `return { open: ${BOX_JS} }`, { timeoutMs: 8000 });
      if (!(st2 && st2.open)) {
        const e = new Error("点相机按钮后上传面板没有展开; 京东页面结构可能改版或搜索栏 JS 未就绪");
        e.status = 500;
        throw e;
      }
    }

    // 4) 上传图片(固定 id 直传)
    const up = await uploadImage(tabId, p.image_path);
    if (up.dispatched !== true) {
      const e = new Error("图片上传失败: " + (up.error || "unknown"));
      e.status = 500;
      throw e;
    }

    // 5) 上传后确认面板进入「确定搜索」状态(按钮文本="搜索"), 再点它触发搜索。
    //    京东面板初始状态按钮文本是「上传图片」, 塞文件后 change 事件应把它变成「搜索」。
    //    若复用标签/加载时序导致 change 没被 React 处理, 按钮仍是「上传图片」——
    //    此时点它会触发原生 file input 的系统文件框, 而不是搜索(这是批量跑挂的根因)。
    //    所以这里轮询校验按钮文本, 不是「搜索」就手动补发 change 事件兜底, 绝不盲点。
    const confirmBy = Date.now() + 8000;
    let btnText = "";
    let searchBtnReady = false;
    while (Date.now() < confirmBy) {
      const st = await jsEval(tabId, `
        var btn = document.querySelector(${JSON.stringify(SEARCH_BTN_SELECTOR)});
        var inp = document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)});
        var txt = btn ? (btn.innerText||'').replace(/\\s+/g,'').trim() : '';
        if (txt === '搜索') return { ok:true, txt:txt };
        if (inp && inp.files && inp.files.length > 0) {
          try { inp.dispatchEvent(new Event('change', {bubbles:true})); } catch(e){}
        }
        return { ok:false, txt:txt };
      `, { timeoutMs: 8000 });
      if (st && st.ok) { searchBtnReady = true; break; }
      if (st && st.txt) btnText = st.txt;
      await sleep(500);
    }
    if (!searchBtnReady) {
      const e = new Error("图片已塞入文件框, 但京东面板没有进入「确定搜索」状态(按钮仍是" + (btnText ? "「" + btnText + "」" : "空") + "), 手动补发 change 也没生效; 为避免误点「上传图片」按钮触发系统文件框, 已中止。京东结构可能改版或触发限流");
      e.status = 500;
      throw e;
    }
    await sleep(200); // 按钮确认是「搜索」后再稳一下
    const clickedSearch = await clickSelector(tabId, windowId, SEARCH_BTN_SELECTOR);
    if (!clickedSearch) {
      const e = new Error("图片已上传, 找到了「搜索」按钮但点击失败(定位/可见性变化); 京东页面结构可能改版");
      e.status = 500;
      throw e;
    }

    // 6) 等结果
    const raw = await waitForResults(tabId, p.wait_ms, page);

    const items = (raw && raw.items ? raw.items : [])
      .slice(0, p.max_items)
      .map((it) => ({
        sku: it.sku || null,
        title: it.title || "",
        price: it.price != null ? parseFloat(it.price) : null,
        price_raw: it.price != null ? "¥" + it.price : null,
        shop: it.shop || null,
        sales: it.sales || null,
        praise: it.praise != null ? it.praise + "%" : null,
        url: it.sku ? "https://item.jd.com/" + it.sku + ".html" : "",
        image: it.image || "",
      }));

    // 超时仍没跳到结果页(path=/image) -> 搜索没触发(可能限流), 明确报错而不是安静返回 0 条
    if (items.length === 0 && (raw && raw.path) !== "/image") {
      const e = new Error("图片已上传, 但点「搜索」后没有跳到结果页(search.jd.com/image); 可能触发京东限流, 或搜索按钮点击未生效, 需真机复核");
      e.status = 502;
      e.hint = "连续调用可能触发京东图片搜索限流, 请暂停一段时间后再试。";
      throw e;
    }

    const result = {
      source: "jd via web-to-openapi",
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
          sheet: "京东搜同款",
          header: ["序号", "SKU", "标题", "价格(元)", "销量", "好评率", "店铺", "链接"],
          rows: items.map((it, i) => [i + 1, it.sku, it.title, it.price, it.sales || "", it.praise || "", it.shop || "", it.url]),
        });
        result.file = outFile;
      } catch (e) {
        result.file = null;
        result.excel_error = String(e.message || e);
      }
    }

    result.calibration_hint =
      "京东结果页 DOM 会随改版变化, 提取字段(尤其店铺/销量)为多策略兜底, 建议首次真机跑通后按实际结构微调 EXTRACT_JS。当前只抓第一页(约 30 条)。";
    return result;
  } finally {
    await closePage(page); // keepOpen 的复用标签不会被关
  }
}

module.exports = {
  id: "jd",
  title: "京东搜同款(以图搜图)",
  concurrency: 1,
  endpoints: [
    {
      method: "POST",
      methods: ["POST", "GET"],
      path: "/api/v1/jd/search-by-image",
      tool: "jd_search_by_image",
      operationId: "jdSearchByImage",
      summary: "京东以图搜同款(上传本地图片 -> 商品列表)",
      description:
        "给一张本地商品图, 找到京东上的同款/相似商品列表(标题/价格/销量/好评/店铺/链接), 返回 JSON 并落 xlsx。参数: image_path(本地图片绝对路径, 必填); tabId(复用已打开的京东页); wait_ms(等结果上限, 默认 25000); max_items(默认 60, 实际第一页约 30 条); out(xlsx 输出路径, 默认 %LOCALAPPDATA%\\webtoopenapi\\exports); no_excel(true 跳过落表)。复用你浏览器里的京东登录态, 遇登录/验证码会把页面切到前台。",
      example: { image_path: "D:/产品图.jpg" },
      responses: { 200: { description: "商品列表 JSON + xlsx 路径" }, 400: { description: "图片路径缺失/不存在" }, 500: { description: "上传失败/未登录/反爬/结构变化" } },
      browser: true,
      parse: parseRequest,
      run: searchByImage,
      doc: {
        note: "京东以图搜同款。给本地图片绝对路径, 自动 进京东首页 → 点相机 → 上传 → 抓同款商品列表(JSON + xlsx)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/jd/search-by-image \\
  -H "Content-Type: application/json" \\
  -d '{"image_path":"D:/产品图.jpg"}'`,
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "jd_search_by_image",
      description:
        "京东以图搜同款: 给一张本地商品图(绝对路径), 找到京东同款/相似商品列表(标题/价格/销量/好评/店铺/链接), 返回 JSON 并落 xlsx。链路: 进 www.jd.com 首页 → 点搜索框内相机按钮 → 上传(CDP DOM.setFileInputFiles) → 点搜索按钮二次确认 → 等结果页 → 抓列表。复用你浏览器里的京东登录态; 遇登录/验证码会把页面切到前台。tabId 可复用已开的京东页; out 指定 xlsx 路径(默认写 %LOCALAPPDATA%\\webtoopenapi\\exports); no_excel=true 只回 JSON。",
      inputSchema: {
        type: "object",
        properties: {
          image_path: { type: "string", description: "本地商品图片绝对路径(如 D:/产品图.jpg), 必填" },
          tabId: { type: "integer", description: "复用已打开的京东标签页 id(可选)" },
          wait_ms: { type: "integer", minimum: 5000, description: "等结果页上限(毫秒, 默认 25000)" },
          max_items: { type: "integer", minimum: 1, maximum: 200, description: "最多返回多少条(默认 60, 实际第一页约 30 条)" },
          out: { type: "string", description: "xlsx 输出绝对路径(可选, 默认 %LOCALAPPDATA%\\webtoopenapi\\exports\\jd-搜同款-时间戳.xlsx)" },
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
