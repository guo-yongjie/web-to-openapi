"use strict";
/*
 * 并发页「冷却」回归(单独一个文件 = 单独一个进程)。
 *
 * 为什么单独放: 冷却标记 parallelBadUntil 是站点模块的模块级状态, 同一个测试进程里
 * 前面的用例会把它改掉(踩过: 放在 ysbnag-parallel-incomplete.test.js 里第 3 例会假失败)。
 * 这里只测一件事: 半页降级之后, 30 分钟内的下一次调用应直接串行, 不再白开并发窗口。
 *
 * 运行: node --test host/test/*.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fakeBrowser = require("./helpers/fake-browser");

test("半页降级后进入冷却: 下一次调用直接串行, 不再白开窗口", async () => {
  // 第 2 页的标签只渲染 11 张卡(真机实测值), 串行重取时才补满 60
  const fake = fakeBrowser.install({ shortOnce: { 2: 11 } });
  const registry = require("../lib/registry");
  require("../sites");
  const e = registry.allEndpoints().find((x) => x.path === "/api/v1/ysbang/price");

  // 第一次: 触发完整性闸门 -> 作废并发 -> 降级串行 + 进入冷却
  const p1 = e.parse(new URLSearchParams("q=化积口服液&mode=full&pages=3&tabs=3&ttl=0"));
  const out1 = await e.run(p1);
  assert.strictEqual(out1.concurrency.degrade_reason, "parallel_incomplete", "前置条件: 第一次必须触发降级");
  assert.strictEqual(out1.count, 180, "降级后仍应是完整三页");
  const afterFirst = fake.stats.tabsOpened;

  // 第二次: 冷却期内应直接走串行(只开 1 个协调标签), 不再开并发窗口
  const p2 = e.parse(new URLSearchParams("q=藿香正气颗粒&mode=full&pages=3&tabs=3&ttl=0"));
  const out2 = await e.run(p2);

  assert.strictEqual(out2.count, 180);
  assert.strictEqual(out2.concurrency.mode, "sequential");
  assert.strictEqual(fake.stats.tabsOpened - afterFirst, 1, "冷却期内不该再开并发窗口");
});
