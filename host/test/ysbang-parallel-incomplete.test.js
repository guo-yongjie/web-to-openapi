"use strict";
/*
 * 真机(2026-11-03 23:1x)暴露的第三个并发缺陷: 并发页只拿到「半页」数据。
 *
 * 现象: pages=3&tabs=3 返回 77 条(各页 60/11/6), 同样参数串行是 171 条(60/58/53)。
 * 根因: 该站是 hash 路由 + SPA 接管分页, 冷启动开 page=2 的窗口时先渲第 1 页,
 *       再切到第 2 页; 切换过程中只画了十几张卡片就停住(实测隐藏窗口 8s 后才有 65 张)。
 *       默认的「两次读数相同即稳定」正好卡在这个中间态。
 *
 * 修复(双层):
 *   ① 抽取层: extractSerp 支持 expect(够一页的条数就立即返回), 不够才退化为静置判定;
 *   ② 调度层: 完整性闸门 —— 任何一页条数不到应有条数的 60%, 整轮并发结果作废,
 *      交回外层走串行, 并冷却 30 分钟不再尝试并发(避免每次白发一轮请求)。
 *
 * 运行: node --test host/test/*.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const fakeBrowser = require("./helpers/fake-browser");

function freshInstall(opts) {
  const path = require("path");
  for (const k of Object.keys(require.cache)) {
    // registry 会把站点模块缓存住, 不清它的话「并发冷却」这类模块级状态会带到下一个用例
    if (
      k.indexOf("host" + path.sep + "sites") >= 0 ||
      k.indexOf("fake-browser") >= 0 ||
      k.indexOf("lib" + path.sep + "registry") >= 0
    ) {
      delete require.cache[k];
    }
  }
  const fake = fakeBrowser.install(opts || {});
  const registry = require("../lib/registry");
  require("../sites");
  return { fake, registry };
}

test("并发页只渲染出半页: 必须作废并发结果并降级串行, 不能返回半截数据", async () => {
  // 第 2 页第一次抽取只给 11 条(真机实测值), 之后(串行重取)给完整 60 条
  const { registry } = freshInstall({ shortOnce: { 2: 11 } });
  const e = registry.allEndpoints().find((x) => x.path === "/api/v1/ysbang/price");
  const p = e.parse(new URLSearchParams("q=化积口服液&mode=full&pages=3&tabs=3&ttl=0"));
  const out = await e.run(p);

  assert.strictEqual(out.count, 180, "降级串行后三页应完整(修复前这里会是 60+11+60=131)");
  assert.deepStrictEqual(Array.from(new Set(out.items.map((i) => i.page))), [1, 2, 3]);
  assert.ok(out.concurrency, "降级也要声明并发状态, 不能静默");
  assert.strictEqual(out.concurrency.degraded, true);
  assert.strictEqual(out.concurrency.degrade_reason, "parallel_incomplete");
  assert.ok(out.concurrency.hint && out.concurrency.hint.indexOf("半页") >= 0, "要给人话原因");
});

test("并发页数据完整时不该误判降级", async () => {
  const { registry } = freshInstall({});
  const e = registry.allEndpoints().find((x) => x.path === "/api/v1/ysbang/price");
  const p = e.parse(new URLSearchParams("q=化积口服液&mode=full&pages=3&tabs=3&ttl=0"));
  const out = await e.run(p);

  assert.strictEqual(out.concurrency.mode, "page_parallel");
  assert.strictEqual(out.concurrency.short_pages, undefined, "完整数据不应出现 short_pages");
  assert.strictEqual(out.count, 180);
});
