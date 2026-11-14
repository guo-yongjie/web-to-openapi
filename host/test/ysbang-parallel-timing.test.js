"use strict";
/*
 * 真机暴露的两个并发缺陷(2026-11-03 22:5x 实测日志), 这里用假浏览器钉住:
 *
 *  ① 「探测吃掉并发」: 3 页场景先探测 page2, 探测完队列只剩 1 页,
 *     tabs = min(3, 1) = 1 —— 日志里出现 "parallel pages=3 tabs=1", 等于没并发。
 *     修复: 探测只在 pageCount>=4 时做。
 *
 *  ② 「页码读太早」: waitReady 在 document.readyState=complete 就返回, 此时 SPA 还没
 *     把 hash 的 page=N 应用到路由, 读到 page=1 就被判成「页码参数不被接受」,
 *     整轮回退串行并置 pageUrlMode=no。日志里 probe ok 与"实际 1"交替出现即是此因。
 *     修复: 页码确认改短轮询(最多 ~2.4s), 不一次判死。
 *
 * 运行: node --test host/test/*.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

// 每个用例需要独立的假浏览器状态, 所以在一个文件里用子测试串行跑并重装
const fakeBrowser = require("./helpers/fake-browser");

function freshInstall(opts) {
  // 清掉 require 缓存, 让 sites/ysbang 的模块级状态(pageUrlMode/busyTabs/cache)重新初始化
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf("host" + require("path").sep + "sites") >= 0 || k.indexOf("fake-browser") >= 0) {
      delete require.cache[k];
    }
  }
  const fake = fakeBrowser.install(opts || {});
  const registry = require("../lib/registry");
  require("../sites");
  return { fake, registry };
}

test("3 页时并发度必须是 2(探测不再吃掉一页)", async () => {
  const { fake, registry } = freshInstall({});
  const e = registry.allEndpoints().find((x) => x.path === "/api/v1/ysbang/price");
  const p = e.parse(new URLSearchParams("q=化积口服液&mode=full&pages=3&tabs=3&ttl=0"));
  const out = await e.run(p);

  assert.strictEqual(out.pages_fetched, 3);
  assert.strictEqual(out.count, 180, "3 页各 60 条");
  assert.deepStrictEqual(Array.from(new Set(out.items.map((i) => i.page))), [1, 2, 3]);
  assert.ok(out.concurrency, "必须声明并发状态");
  assert.strictEqual(out.concurrency.mode, "page_parallel", "3 页应真并发, 不该被探测降成串行");
  assert.strictEqual(out.concurrency.tabs, 2, "修复前这里是 1(探测占掉一页后只剩一页可跑)");
  assert.strictEqual(fake.stats.tabsOpened, 3, "协调标签(第1页) + page2 + page3 各一个窗口");
});

test("页码延迟生效: 短轮询应等得住, 不误判为「不接受 page 参数」", async () => {
  // 前 2 次读页码都返回 1(旧页), 第 3 次才读到真实页码
  const { registry } = freshInstall({ pageApplyDelay: 2 });
  const e = registry.allEndpoints().find((x) => x.path === "/api/v1/ysbang/price");
  const p = e.parse(new URLSearchParams("q=化积口服液&mode=full&pages=3&tabs=3&ttl=0"));
  const out = await e.run(p);

  assert.strictEqual(out.concurrency.mode, "page_parallel", "延迟生效属于正常时序, 不应降级");
  assert.strictEqual(out.pages_fetched, 3);
  assert.deepStrictEqual(Array.from(new Set(out.items.map((i) => i.page))), [1, 2, 3]);
});

test("批量询价: 两个品种不抢同一个搜索标签", async () => {
  const { fake, registry } = freshInstall({});
  // 预置一个用户已打开的搜索页 —— 修复前两个 worker 都会复用它, 互相把词改掉
  fake.seed("https://dian.ysbang.cn/#/indexContent?searchkey=%E6%97%A7%E8%AF%8D&page=1&pagesize=60");

  const e = registry.allEndpoints().find((x) => x.path === "/api/v1/ysbang/batch");
  const p = e.parse(new URLSearchParams("qs=甲药,乙药&mode=cheapest&pages=1&ttl=0"));
  const out = await e.run(p);

  assert.strictEqual(out.query_count, 2);
  assert.strictEqual(out.ok_count, 2);
  // 一个复用已有标签, 另一个必须新开; 若两个都复用, tabsOpened 会是 0
  assert.strictEqual(fake.stats.tabsOpened, 1, "第二个 worker 必须另开标签, 不能和第一个共用");
  // 结果按入参顺序返回
  assert.deepStrictEqual(out.results.map((r) => r.q), ["甲药", "乙药"]);
});
