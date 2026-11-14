"use strict";
/*
 * 浏览器并发准入与节流闸回归测试(v1.5.0)
 * ---------------------------------------------------------------------------
 * 目的: 锁死两件事
 *   1) 站点并发槽不会超卖(默认 1 槽 = 旧版全局串行的语义)
 *   2) 页级节流闸对并发调用形成串行间隔(并发不等于把请求挤成一堆)
 * 运行: node --test host/test/
 */
const test = require("node:test");
const assert = require("node:assert");
const { withBrowserSlot, createPacer, slotLimitOf } = require("../lib/util");
const { CONFIG } = require("../lib/config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("信号量: limit=2 时并发峰值不超过 2", async () => {
  let active = 0;
  let peak = 0;
  const task = () => withBrowserSlot("test:sema", 2, async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(30);
    active--;
  });
  await Promise.all(Array.from({ length: 6 }, task));
  assert.strictEqual(peak, 2, `并发峰值应为 2, 实际 ${peak}`);
  assert.strictEqual(active, 0);
});

test("信号量: limit=1 等价串行(旧 withBrowserLock 语义)", async () => {
  const order = [];
  const mk = (id) => withBrowserSlot("test:serial", 1, async () => {
    order.push("start" + id);
    await sleep(10);
    order.push("end" + id);
  });
  await Promise.all([mk(1), mk(2), mk(3)]);
  assert.deepStrictEqual(order, ["start1", "end1", "start2", "end2", "start3", "end3"]);
});

test("信号量: 任务抛错也要释放槽位, 不堵死后续调用", async () => {
  await assert.rejects(withBrowserSlot("test:err", 1, async () => { throw new Error("boom"); }));
  const ok = await withBrowserSlot("test:err", 1, async () => "ok");
  assert.strictEqual(ok, "ok");
});

test("节流闸: 连续两次 wait 之间有最小间隔", async () => {
  const pacer = createPacer(60, 60);
  const t0 = Date.now();
  await pacer.wait();
  await pacer.wait();
  const gap = Date.now() - t0;
  assert.ok(gap >= 45, `两次发车间隔应 >= 45ms, 实际 ${gap}ms`);
});

test("节流闸: mark() 会把下一个号推到未来, 并发调用不会紧贴着串行路径发车", async () => {
  const pacer = createPacer(80, 80);
  pacer.mark();
  const t0 = Date.now();
  await pacer.wait();
  assert.ok(Date.now() - t0 >= 40, "mark 之后的第一个 wait 应等待");
});

test("槽位上限: 端点声明 > 站点声明 > 全局封顶", () => {
  CONFIG.browser_concurrency = 0;
  assert.strictEqual(slotLimitOf({ concurrency: 2 }), 2);
  assert.strictEqual(slotLimitOf({ site: { concurrency: 3 } }), 3);
  assert.strictEqual(slotLimitOf({ concurrency: 2, site: { concurrency: 3 } }), 2);
  assert.strictEqual(slotLimitOf({}), 1);

  CONFIG.browser_concurrency = 1; // 调试开关: 强制回到全局串行
  assert.strictEqual(slotLimitOf({ concurrency: 3 }), 1);
  CONFIG.browser_concurrency = 0;
});
