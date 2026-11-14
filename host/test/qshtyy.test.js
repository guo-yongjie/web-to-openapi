"use strict";
/*
 * qshtyy(海豚药药 / 兰州强生)站点模块测试。
 *
 * 这个站点没有字体反爬, 走站内 JSON 接口(onCondition + goodsInfo/list),
 * 所以这里钉的不是「解析是否正确」, 而是四条容易悄悄坏掉的契约:
 *   ① 短键 -> 可读字段的映射与类型(价格必须是数字, 否则排序/比价全错);
 *   ② 登录失效走 needs_human 而不是静默空列表(空列表会被误读成"没有这个药");
 *   ③ 站点接口异常 (code!=200) 必须显式报错, 不能返回 0 条;
 *   ④ 缓存命中时不得再碰浏览器(否则 5 分钟缓存等于没有)。
 *
 * 运行: node --test host/test/qshtyy.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

/*
 * 每次用例都要一个「全新鲜」的模块图:
 *   - sites 模块有模块级状态(缓存 Map / 熔断), 必须重载;
 *   - lib/util 在加载时就解构了 nm.callTool, 所以 nm/util 也必须跟着重载,
 *     否则新装的假浏览器根本接不到调用(旧 util 仍握着旧 nm 的函数引用)。
 * 因此这里清掉整个 host 目录的 require 缓存(排除 node_modules), 再重新 require。
 */
function freshInstall(opts) {
  const hostRoot = path.join(__dirname, "..");
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(hostRoot) === 0 && k.indexOf("node_modules") < 0) delete require.cache[k];
  }
  const fb = require("./helpers/fake-browser");
  const fake = fb.install(opts || {});
  require("../sites");
  const registry = require("../lib/registry");
  return { fake, registry };
}

function endpoint(registry, p) {
  return registry.allEndpoints().find((x) => x.path === p);
}

test("短键映射: 价格/库存/效期/起订量必须是可用类型", async () => {
  const { registry } = freshInstall();
  const e = endpoint(registry, "/api/v1/qshtyy/price");
  const out = await e.run(e.parse(new URLSearchParams("q=化积口服液")));

  assert.strictEqual(out.count, 3);
  assert.strictEqual(out.total, 3);
  assert.strictEqual(out.truncated, false);
  assert.strictEqual(out.query, "化积口服液");

  const it = out.items[0];
  assert.strictEqual(typeof it.price, "number", "price 必须转成数字(排序与比价都依赖它)");
  assert.strictEqual(it.price, 11);
  assert.strictEqual(it.retail_price, 13);
  assert.strictEqual(it.market_price, 0);
  assert.strictEqual(it.stock, 100);
  assert.strictEqual(it.in_stock, true);
  assert.strictEqual(it.expiry, "2028-06-01");
  assert.strictEqual(it.moq, 1);
  assert.strictEqual(it.pack, 10);
  assert.strictEqual(it.piece, 100);
  assert.strictEqual(it.unit, "盒");
  assert.strictEqual(it.approval, "国药准字H0000001");
  assert.strictEqual(it.insurance, "医保乙类");
  assert.strictEqual(it.purchase_tag, "I-A+1");
  assert.deepStrictEqual(it.labels, [10], "label 数字数组要从逗号串还原");
  assert.ok(out.price_min === 11 && out.price_max === 13);
});

test("本地筛选与排序: in_stock / sort=price_desc / min_expiry", async () => {
  const rows = [
    { i: 1, n: "A", s: "10ml*12支", m: "厂A", p: "5.00", rp: "6.00", mp: "0", sq: 0, e: "2027-01-01", mo: 1, pk: 1, pc: 1, u: "盒", ap: "", ins: "", tg: "", ct: "", lb: "" },
    { i: 2, n: "B", s: "10ml*12支", m: "厂B", p: "9.00", rp: "10.00", mp: "0", sq: 50, e: "2029-01-01", mo: 1, pk: 1, pc: 1, u: "盒", ap: "", ins: "", tg: "", ct: "", lb: "" },
    { i: 3, n: "C", s: "10ml*12支", m: "厂C", p: "7.00", rp: "8.00", mp: "0", sq: 20, e: "2028-05-01", mo: 1, pk: 1, pc: 1, u: "盒", ap: "", ins: "", tg: "", ct: "", lb: "" },
  ];
  const { registry } = freshInstall({ qshtyyRows: { 测试: rows } });
  const e = endpoint(registry, "/api/v1/qshtyy/price");

  const sorted = await e.run(e.parse(new URLSearchParams("q=测试&sort=price_desc")));
  assert.deepStrictEqual(sorted.items.map((x) => x.name), ["B", "C", "A"]);

  const stocked = await e.run(e.parse(new URLSearchParams("q=测试&in_stock=1&sort=price_asc&nocache=1")));
  assert.deepStrictEqual(stocked.items.map((x) => x.name), ["C", "B"], "库存为 0 的 A 要被过滤");

  const fresh = await e.run(e.parse(new URLSearchParams("q=测试&min_expiry=2028-06&nocache=1")));
  assert.deepStrictEqual(fresh.items.map((x) => x.name), ["B"], "效期早于 2028-06 的都要剔除");
});

test("5 分钟缓存命中时不再碰浏览器", async () => {
  const { fake, registry } = freshInstall();
  const e = endpoint(registry, "/api/v1/qshtyy/price");
  const p = new URLSearchParams("q=阿莫西林胶囊");

  const first = await e.run(e.parse(p));
  assert.strictEqual(first.cached, false);
  const callsAfterFirst = fake.stats.qshtyyCalls;
  const closedAfterFirst = fake.stats.closed;

  const second = await e.run(e.parse(new URLSearchParams("q=阿莫西林胶囊")));
  assert.strictEqual(second.cached, true);
  assert.strictEqual(typeof second.cache_age_s, "number");
  assert.strictEqual(fake.stats.qshtyyCalls, callsAfterFirst, "缓存命中后不得再执行页面脚本");
  assert.strictEqual(fake.stats.closed, closedAfterFirst, "缓存命中后不得开/关标签");

  const forced = await e.run(e.parse(new URLSearchParams("q=阿莫西林胶囊&nocache=1")));
  assert.strictEqual(forced.cached, false, "nocache=1 必须绕过缓存");
  assert.ok(fake.stats.qshtyyCalls > callsAfterFirst);
});

test("登录态失效: 走 needs_human 且保留页面", async () => {
  const { fake, registry } = freshInstall({ qshtyyExpired: true });
  const e = endpoint(registry, "/api/v1/qshtyy/price");

  await assert.rejects(
    () => e.run(e.parse(new URLSearchParams("q=化积口服液"))),
    (err) => {
      assert.strictEqual(err.status, 503);
      assert.strictEqual(err.needs_human, true);
      assert.match(err.message, /登录/);
      return true;
    }
  );
  assert.strictEqual(fake.stats.closed, 0, "需要人工登录时不能把标签关掉");
});

test("token 缺失同样判定为登录失效(不返回空列表)", async () => {
  const { registry } = freshInstall({ qshtyyNoToken: true });
  const e = endpoint(registry, "/api/v1/qshtyy/price");
  await assert.rejects(
    () => e.run(e.parse(new URLSearchParams("q=化积口服液"))),
    (err) => err.needs_human === true && err.status === 503
  );
});

test("站点接口异常必须显式报错(不能静默返回 0 条)", async () => {
  const { registry } = freshInstall({ qshtyyApiError: true });
  const e = endpoint(registry, "/api/v1/qshtyy/price");
  await assert.rejects(
    () => e.run(e.parse(new URLSearchParams("q=化积口服液"))),
    (err) => {
      assert.strictEqual(err.status, 502);
      assert.match(err.message, /接口可能已变更/);
      return true;
    }
  );
});

test("宽词截断: total 远大于返回条数时标 truncated", async () => {
  const { registry } = freshInstall({ qshtyyTotal: 2730 });
  const e = endpoint(registry, "/api/v1/qshtyy/price");
  const out = await e.run(e.parse(new URLSearchParams("q=片&limit=100")));
  assert.strictEqual(out.total, 2730);
  assert.strictEqual(out.count, 3, "假浏览器按 limit 生成, 这里只验证 truncated 判定");
  assert.strictEqual(out.truncated, true);
});

test("零结果不是错误: total=0 且不抛", async () => {
  const { registry } = freshInstall({ qshtyyRows: () => [] });
  const e = endpoint(registry, "/api/v1/qshtyy/price");
  const out = await e.run(e.parse(new URLSearchParams("q=不存在的药")));
  assert.strictEqual(out.count, 0);
  assert.strictEqual(out.total, 0);
  assert.strictEqual(out.truncated, false);
});

test("复用已打开的本站标签: 不新增导航、不关闭用户标签", async () => {
  const { fake, registry } = freshInstall();
  fake.seed("https://pc.qshtyy.com/#/searchList");
  const navigationsBefore = fake.stats.navigations;

  const e = endpoint(registry, "/api/v1/qshtyy/price");
  const out = await e.run(e.parse(new URLSearchParams("q=化积口服液")));

  assert.strictEqual(out.reused_tab, true);
  assert.strictEqual(fake.stats.navigations, navigationsBefore, "复用标签不应触发导航");
  assert.strictEqual(fake.stats.closed, 0, "用户的标签不能被关掉");
});

test("批量询价: 按入参顺序返回, 单个品种失败不影响其他", async () => {
  const { registry } = freshInstall({
    qshtyyRows: (q) => {
      if (q === "坏的") throw new Error("boom");
      return undefined; // 交回默认生成
    },
  });
  const e = endpoint(registry, "/api/v1/qshtyy/batch");
  const out = await e.run(e.parse(new URLSearchParams("qs=化积口服液,坏的")));

  assert.strictEqual(out.requested, 2);
  assert.strictEqual(out.ok_count, 1, "一个品种失败不能拖垮整批");
  assert.strictEqual(out.failed_count, 1);
  assert.strictEqual(out.results[0].q, "化积口服液");
  assert.strictEqual(out.results[0].ok, true);
  assert.strictEqual(out.results[1].q, "坏的");
  assert.strictEqual(out.results[1].ok, false);
  assert.match(out.results[1].error, /boom/);
  assert.strictEqual(out.aborted, false, "普通错误不应中断后续品种");
});

test("批量超过 10 个品种直接 400", async () => {
  const { registry } = freshInstall();
  const e = endpoint(registry, "/api/v1/qshtyy/batch");
  const many = Array.from({ length: 11 }, (_, i) => `药${i}`).join(",");
  assert.throws(
    () => e.parse(new URLSearchParams(`qs=${encodeURIComponent(many)}`)),
    (err) => err.status === 400
  );
});

test("跨平台比价: include_ysbang=false 时只查海豚药药", async () => {
  const { registry } = freshInstall();
  const e = endpoint(registry, "/api/v1/compare/price");
  const out = await e.run(e.parse(new URLSearchParams("q=化积口服液&include_ysbang=false")));

  assert.strictEqual(out.qshtyy.ok, true);
  assert.strictEqual(out.qshtyy.count, 3);
  assert.strictEqual(out.ysbang.skipped, true);
  assert.strictEqual(out.diff, null, "缺少一方价格时不能编造差价");
  assert.ok(out.qshtyy.lowest && out.qshtyy.lowest.price === 11);
  assert.match(out.caveat, /口径/);
});

test("药师帮条目可比性标注: 临期/预约/乱码必须被识别出来", async () => {
  const { registry } = freshInstall();
  const site = registry.all().find((s) => s.id === "qshtyy");
  const { prepareYsbangItem, monthsAhead } = site._internal;

  // 实测样本(2026-11-14 化积口服液): 0.50 元那条来自「药店品种预约中心」, 效期只剩一个多月
  const presale = prepareYsbangItem({
    name: "68盒包邮 好娃友 化积口服液10ml*6支",
    factory: "恩威(江西)制药有限公司",
    shop: "药店品种预约中心",
    price: "0.50",
    expiry: "2026-12-31",
  });
  assert.strictEqual(presale.presale, true, "预约/预售店铺要标出来");
  assert.strictEqual(presale.short_expiry, true, "效期不足 6 个月要标出来");
  assert.strictEqual(presale.name_garbled, false, "品名含通用词(口服液)不该判乱码");
  assert.strictEqual(presale.price, 0.5);

  // 字体反爬残留的乱码品名(真实样本)
  const garbled = prepareYsbangItem({
    name: "填兮剹临俍奆夹呍啿威孲創嘙剽娃凒勤乆奰劵圪倀傜嗅娖凢官囀",
    price: "5.30",
    expiry: "2028-10-02",
  });
  assert.strictEqual(garbled.name_garbled, true, "整串生僻字要判乱码");

  // 正常正价货: 什么都不标
  const normal = prepareYsbangItem({
    name: "1盒起购 好娃友 化积口服液10ml*6支",
    shop: "闪药购",
    price: "5.40",
    expiry: "2027-05-31",
  });
  assert.strictEqual(normal.presale, false);
  assert.strictEqual(garbled.short_expiry, false);
  assert.ok(monthsAhead(6).length === 10);
});

test("跨平台比价: 全场最低价不可信时, fair 节点要给出同口径数字", async () => {
  const { registry } = freshInstall();
  const e = endpoint(registry, "/api/v1/compare/price");
  const out = await e.run(e.parse(new URLSearchParams("q=化积口服液&include_ysbang=true")));

  assert.strictEqual(out.ysbang.ok, true);
  assert.ok(out.fair, "缺少 fair 节点等于把临期价当结论");
  assert.strictEqual(typeof out.fair.basis, "string");
  assert.ok(out.fair.qshtyy.count > 0);
  assert.ok(out.fair.ysbang.count > 0);
  assert.ok(out.fair.diff, "同口径两边都有价时应算出 diff");
  assert.ok(typeof out.fair.excluded.ysbang === "number");
  // 全场最低与同口径最低必须是两个独立口径(可能相等, 但节点都要在)
  assert.ok(out.diff && out.fair.diff);
});

test("品名差异识别: 消食化积口服液不能被当成化积口服液", async () => {
  const { registry } = freshInstall();
  const { nameExtraOf } = registry.all().find((s) => s.id === "qshtyy")._internal;

  assert.strictEqual(nameExtraOf("化积口服液", "1盒起购 好娃友 化积口服液10ml*6支"), "", "有品牌前缀但品名一致");
  assert.strictEqual(nameExtraOf("化积口服液", "40盒包邮川奇 消食化积口服液10ml*6支"), "消食", "多出的修饰词必须暴露出来");
  assert.strictEqual(nameExtraOf("化积口服液", "阿莫西林胶囊"), null, "不含基础名 = 不同品种");
  assert.strictEqual(nameExtraOf("化积口服液(玻)", "化积口服液10ml*6支"), "", "基础名要先去括号");
});

test("厂家名归一: 括号/后缀差异视为同一家, 不同厂必须区分", async () => {
  const { registry } = freshInstall();
  const { mfKey } = registry.all().find((s) => s.id === "qshtyy")._internal;

  assert.strictEqual(mfKey("恩威(江西)制药有限公司"), "恩威");
  assert.strictEqual(mfKey("恩威（江西）制药有限公司"), "恩威");
  assert.strictEqual(mfKey("江西诚志永丰药业有限责任公司"), "江西诚志永丰");
  assert.strictEqual(mfKey("哈药集团制药总厂"), "哈药");
  assert.notStrictEqual(mfKey("江西诚志永丰药业有限责任公司"), mfKey("恩威(江西)制药有限公司"));
});

test("缺少 q 时 400 且给用法提示", async () => {
  const { registry } = freshInstall();
  const e = endpoint(registry, "/api/v1/qshtyy/price");
  assert.throws(
    () => e.parse(new URLSearchParams("")),
    (err) => err.status === 400 && /q/.test(err.hint)
  );
});
