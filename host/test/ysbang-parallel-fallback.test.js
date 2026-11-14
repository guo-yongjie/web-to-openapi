"use strict";
/*
 * 页级并发的降级路径: SPA 不接受 page 参数时必须退回串行翻页。
 * ---------------------------------------------------------------------------
 * 这条路径比并发本身更关键 —— 它是「快但不保证对」和「慢但一定对」之间的开关。
 * 用 ignoresPageParam=true 模拟: 新标签永远只渲染第 1 页, 页码核对必然失败。
 * 期望: 不报错, 自动退回串行翻页, 结果仍是 2 页 120 条。
 * 运行: node --test host/test/*.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const fake = require("./helpers/fake-browser").install({ ignoresPageParam: true });
const registry = require("../lib/registry");
require("../sites");

test("page 参数不被接受: 自动退回串行翻页, 结果完整且降级可见", async () => {
  const e = registry.allEndpoints().find((x) => x.path === "/api/v1/ysbang/price");
  const p = e.parse(new URLSearchParams("q=化积口服液&mode=full&pages=2&tabs=3&ttl=0"));
  const out = await e.run(p);

  /*
   * v1.5.1: 降级必须显式可见 —— 传了 tabs=3 却走串行, 响应里要有 mode/degrade_reason,
   * 否则调用方以为自己在并发跑(静默降级正是被抓出来的毛病)。
   */
  assert.strictEqual(out.concurrency.mode, "sequential", "降级后必须标明走的是串行");
  assert.strictEqual(out.concurrency.degraded, true);
  assert.strictEqual(out.concurrency.requested_tabs, 3);
  assert.strictEqual(out.concurrency.degrade_reason, "page_url_not_accepted");
  assert.strictEqual(out.pages_fetched, 2);
  assert.strictEqual(out.count, 120, "串行翻页两页各 60 条");
  assert.deepStrictEqual(Array.from(new Set(out.items.map((i) => i.page))), [1, 2]);
  // 并发标签被关掉, 没有泄漏的窗口
  assert.ok(fake.stats.closed >= 1);
});
