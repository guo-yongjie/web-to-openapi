"use strict";
/*
 * 药师帮页级并发 / 批量询价的端到端回归(假浏览器)
 * ---------------------------------------------------------------------------
 * 验证:
 *   1) tabs=3 + pages=3 -> 3 个标签并行, 第 1 页留在协调标签, 结果 180 条不重不漏
 *   2) 并发不改变「每页一次请求」的请求形态(requests 不因并发而翻倍)
 *   3) /batch 两个品种 -> 2 个标签并发, 结果按入参顺序返回
 * 运行: node --test host/test/*.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

// ⚠ 顺序要求: 先装假浏览器, 再加载站点模块(util 在 require 时就解构了 callTool)
const fake = require("./helpers/fake-browser").install({});
const registry = require("../lib/registry");
require("../sites");

const ep = (p) => registry.allEndpoints().find((e) => e.path === p);

test("tabs=3 页级并发: 3 页 180 条, 请求数仍是每页一次", async () => {
  const e = ep("/api/v1/ysbang/price");
  const p = e.parse(new URLSearchParams("q=化积口服液&mode=full&pages=3&tabs=3&ttl=0"));
  const out = await e.run(p);

  assert.strictEqual(out.concurrency.mode, "page_parallel");
  assert.strictEqual(out.pages_fetched, 3);
  assert.deepStrictEqual(out.concurrency.pages_scanned, [1, 2, 3]);
  assert.strictEqual(out.count, 180, "3 页各 60 条, 且不能重复");
  assert.strictEqual(out.requests, 3, "1 次搜索 + 2 次并发页导航(第 1 页复用首次加载)");
  // 去重校验: 每页药品名不同
  const names = new Set(out.items.map((i) => i.name));
  assert.strictEqual(names.size, 180);
  assert.ok(out.items.some((i) => i.page === 3));
});

test("batch: 两个品种并发, 结果按入参顺序返回", async () => {
  const e = ep("/api/v1/ysbang/batch");
  const { base, qs } = e.parse(new URLSearchParams("qs=化积口服液,藿香正气颗粒&mode=cheapest&pages=2&ttl=0"));
  const out = await e.run({ base, qs });

  assert.strictEqual(out.parallel, 2, "批量默认 2 个并发标签");
  assert.strictEqual(out.query_count, 2);
  assert.strictEqual(out.ok_count, 2);
  assert.deepStrictEqual(out.results.map((r) => r.q), qs);
  for (const r of out.results) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.mode, "cheapest");
    assert.ok(r.data.count > 0);
  }
});
