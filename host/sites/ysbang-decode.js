// 药师帮(dian.ysbang.cn)搜索结果解析脚本
// ---------------------------------------------------------------------------
// 本文件不作为 Node 模块 require, 由 sites/ysbang.js 以纯文本读取后注入页面执行
// (chrome_javascript / CDP Runtime.evaluate 的函数体上下文, 末尾 return 即结果)。
//
// 破解要点(2026-10-19 实测):
//   1) 接口层: getWholesaleList 返回 AES 密文 {i, o}, 不可直接读
//   2) 字体层: 价格用动态注入的 ysb-din-bold 渲染, DOM 文本是乱码汉字,
//      且为「多码点连字」—— 单字符渲染得不到数字字形
//   3) 解法: 整段渲染触发连字 -> 垂直投影切字形 -> 归一化 16x24 位图
//      与 0-9 模板做汉明距离匹配; 宽度 < 9px 的字形判为小数点
//
// 约束: 不得返回 location.href / hash / 任何查询串 —— 扩展侧会整块脱敏成
//       [BLOCKED: Cookie/query string data], 导致结果不可用。
// ---------------------------------------------------------------------------
const cv = document.createElement("canvas");
cv.width = 1400; cv.height = 90;
const g = cv.getContext("2d", { willReadFrequently: true });
g.font = '52px "ysb-din-bold"';
g.textBaseline = "top";
g.fillStyle = "#000";

function render(text) {
  g.clearRect(0, 0, 1400, 90);
  // 必须先铺白底: 后续按 R 通道亮度二值化, 透明像素 R=0 会被误判成笔画
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 1400, 90);
  g.fillStyle = "#000";
  g.fillText(text, 5, 8);
  const w = Math.ceil(g.measureText(text).width);
  const stride = Math.min(w + 10, 1400);
  return { w: w, alpha: g.getImageData(0, 0, stride, 90).data, stride: stride };
}

function binCols(r) {
  const cols = [];
  for (let x = 0; x < r.w; x++) {
    let c = 0;
    for (let y = 0; y < 90; y++) if (r.alpha[(y * r.stride + x) * 4] < 128) c++;
    cols.push(c);
  }
  return cols;
}

function segsOf(r) {
  const cols = binCols(r), segs = [];
  let s = -1;
  for (let x = 0; x < cols.length; x++) {
    if (cols[x] > 0 && s < 0) s = x;
    if (cols[x] === 0 && s >= 0) { if (x - s > 2) segs.push([s, x]); s = -1; }
  }
  if (s >= 0) segs.push([s, cols.length]);
  return segs;
}

function normBits(r, x0, x1) {
  let y0 = 90, y1 = 0;
  for (let y = 0; y < 90; y++) for (let x = x0; x < x1; x++) if (r.alpha[(y * r.stride + x) * 4] < 128) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (y1 <= y0) return null;
  const W = 16, H = 24, bits = [];
  for (let ny = 0; ny < H; ny++) for (let nx = 0; nx < W; nx++) {
    const sx = x0 + Math.floor((nx + 0.5) * (x1 - x0) / W);
    const sy = y0 + Math.floor((ny + 0.5) * (y1 - y0) / H);
    bits.push(r.alpha[(sy * r.stride + sx) * 4] < 128 ? 1 : 0);
  }
  return bits;
}

function ham(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

const tmpl = {};
"0123456789".split("").forEach(function (d) {
  const r = render(d);
  const sg = segsOf(r)[0];
  tmpl[d] = normBits(r, sg[0], sg[1]);
});

function decodeText(t) {
  if (!t) return "";
  const r = render(t);
  let out = "";
  segsOf(r).forEach(function (sg) {
    if (sg[1] - sg[0] < 9) { out += "."; return; }
    const bits = normBits(r, sg[0], sg[1]);
    if (!bits) return;
    let best = "?", bd = 999;
    for (const d in tmpl) { const dist = ham(bits, tmpl[d]); if (dist < bd) { bd = dist; best = d; } }
    out += bd < 60 ? best : "?";
  });
  return out;
}

const cards = [];
document.querySelectorAll(".all-goods-wrapper").forEach(function (card) {
  const priceEl = card.querySelector(".goods-price-all");
  if (!priceEl) return;

  const spans = priceEl.querySelectorAll(".ysb-din-bold");
  let price = "";
  let priceOk = false;
  if (spans.length >= 2) {
    price = decodeText(spans[0].textContent) + decodeText(spans[1].textContent);
    priceOk = price.indexOf("?") < 0;
  }
  let discount = "";
  const dis = card.querySelector(".dis-price");
  if (dis) {
    const dsp = dis.querySelectorAll(".ysb-din-bold");
    if (dsp.length >= 2) discount = decodeText(dsp[0].textContent) + decodeText(dsp[1].textContent);
  }

  const lines = (card.innerText || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean);

  // 商品行形如「1盒起购 润家 化积口服液10ml*6支」/「40袋包邮 海氏海诺 医用棉签10cm 50支」
  // 拆成 prefix(营销前缀) + moq(起购/包邮门槛) + name(纯品名)
  const MOQ_RE = /(\d+)\s*(盒|袋|包|小袋|瓶|支|只|片|个)\s*(起购|包邮)/;
  function splitName(ln) {
    const m = ln.match(MOQ_RE);
    if (!m) return { name: ln, moq: "", prefix: "", shipBoxes: "" };
    return {
      prefix: ln.slice(0, m.index).trim(),
      moq: m[1] + m[2] + m[3],
      shipBoxes: m[3] === "包邮" ? m[1] + m[2] : "",
      name: ln.slice(m.index + m[0].length).trim(),
    };
  }

  // 品名行启发式：既没有「N盒起购」也可能命中（棉签/口罩等非药品品类）
  const NOISE_RE = /^(有效期|加入购物车|立即购买|限购|已拼|约￥|溯|券|满|折后|库存|承诺|包邮$)/;
  const SPEC_RE = /\d+(\.\d+)?\s*(支|片|袋|盒|瓶|包|小袋|ml|mL|ML|g|G|cm|CM|mm|MM|贴|粒|只|个|卷|抽|人份|双)/;
  const NOUN_RE = /口服液|丸|片|胶囊|颗粒|膏|喷剂|贴|液|露|霜|栓|茶|含片|糖浆|棉签|棉球|棉棒|口罩|手套|纱布|创可贴|创口贴|体温计|血压计|湿巾|碘伏|酒精|乙醇|氧气|氧|膜|器|仪|机|垫|带|棒|纸|巾|皂|套|针|管|罐|盒装/;
  function looksLikeName(ln) {
    if (!ln || ln.length < 5 || ln.length > 70) return false;
    if (NOISE_RE.test(ln)) return false;
    if (/^[￥¥\d.]/.test(ln)) return false;
    if (/公司|药业|厂$|旗舰店|专卖店|专营店/.test(ln)) return false;
    return SPEC_RE.test(ln) || NOUN_RE.test(ln);
  }

  let name = "", factory = "", warehouse = "", expiry = "", moq = "", pre = "", shipBoxes = "";
  let factIdx = -1;
  lines.forEach(function (ln, idx) {
    if (ln.indexOf("有效期") === 0) { expiry = ln.slice(3); return; }
    if (factIdx < 0 && /公司|药业|厂$/.test(ln)) { factIdx = idx; factory = ln; return; }
    if (!name && looksLikeName(ln)) {
      const sp = splitName(ln);
      name = sp.name; moq = sp.moq; pre = sp.prefix; shipBoxes = sp.shipBoxes || shipBoxes;
    }
  });
  // 品名兜底：取最长的非噪音行
  if (!name) {
    let best = "";
    lines.forEach(function (ln) {
      if (NOISE_RE.test(ln) || /^[￥¥]/.test(ln)) return;
      if (/公司|药业|厂$/.test(ln)) return;
      if (ln.length <= 70 && ln.length > best.length) best = ln;
    });
    name = best;
  }
  // 包邮门槛兜底：整卡文本里出现「N盒/袋/包 包邮」
  if (!shipBoxes) {
    const sm = (card.innerText || "").match(/(\d+)\s*(盒|袋|包|小袋|瓶|只|片|个)\s*包邮/);
    if (sm) shipBoxes = sm[1] + sm[2];
  }
  // 约￥x/单位 的参考价（用于校验解码结果）
  let unitHint = "";
  const uh = (card.innerText || "").match(/约￥\s*([\d.]+)\s*\/\s*(支|片|袋|盒|瓶|包|只|个|粒)/);
  if (uh) unitHint = uh[1] + "/" + uh[2];


  // 仓库/店铺行位于厂家之后, 形如「500免邮 众远快益达」/「帝豪旗舰店 -广州仓」
  // 注意该行通常不含"仓"字, 不能用关键字匹配, 只能按位置取并排除噪音行
  let shop = "", freeShipFloor = "";
  if (factIdx >= 0) {
    for (let i = factIdx + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (/^溯|^券|^满|^折后|加入购物车|^承诺/.test(ln)) continue;
      warehouse = ln;
      const fs = ln.match(/^(\d+)\s*免邮\s*(.*)$/);
      if (fs) { freeShipFloor = fs[1]; shop = fs[2].trim(); }
      else shop = ln;
      break;
    }
  }

  // 没识别到厂家行时，退化为取最后一个像店铺名的行
  if (!shop) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (NOISE_RE.test(ln) || ln === factory) continue;
      if (/店|旗舰|专卖|医药|药业|公司/.test(ln) && ln.length <= 24) { shop = ln; break; }
    }
  }

  const promo = [];
  lines.forEach(function (ln) {
    if (promo.length >= 4) return;
    if (/^券\s|^券$|^满.*降|专享|补贴|^\d+\s*折|旗舰店\d+折/.test(ln) && ln.length < 24 && promo.indexOf(ln) < 0) promo.push(ln);
  });

  cards.push({
    name: name,
    factory: factory,
    warehouse: warehouse,
    shop: shop,
    free_ship_floor: freeShipFloor,
    free_ship_boxes: shipBoxes,
    moq: moq,
    unit_hint: unitHint,
    promo_prefix: pre,
    expiry: expiry,
    price: price,
    price_ok: priceOk,
    discount: discount,
    promo: promo.join("/"),
    // 库存标签: 页面用「库存紧缺」提示, 其余视为正常
    stock: /库存紧缺/.test(card.innerText) ? "紧缺" : "正常",
  });
});

// 当前页码从 hash 取(只取数字, 不回传 hash 本身)
const pageM = (location.hash || "").match(/[?&]page=(\d+)/);
// 总条数: 页面上的「共 N 条」
const totalM = (document.body.innerText || "").match(/共\s*([\d,]+)\s*条/);
const bodyText = document.body.innerText || "";

return {
  hasList: cards.length > 0,
  page: pageM ? +pageM[1] : null,
  total: totalM ? +String(totalM[1]).replace(/,/g, "") : null,
  ready: document.readyState,
  bodyLen: bodyText.length,
  needLogin: /请先登录|登录后查看|登录已失效/.test(bodyText.slice(0, 3000)),
  count: cards.length,
  items: cards,
};
