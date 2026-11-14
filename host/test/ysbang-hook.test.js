"use strict";
/*
 * 药师帮挂钩的「捕获源选择」回归测试(v1.5.0)
 * ---------------------------------------------------------------------------
 * 目的: 锁死三类会静默出错的场景, 防止后续改动把它们又变回「悄悄挑一个」:
 *   1) 页码/关键词戳对不上 -> 必须明确报 reason, 且不返回任何 items
 *   2) 候选数组长度接近   -> 必须判 ambiguous, 不猜主列表
 *   3) 主列表短于 10 条   -> 必须照常采(末页), 只打 warning
 *
 * 做法: 挂钩脚本本身是「注入页面执行、末尾 return」的函数体, 用 new Function
 * 塞一个假 DOM 进去就能在 Node 里跑, 不需要浏览器与扩展。
 * 运行: node --test host/test/
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const HOOK = fs.readFileSync(path.join(__dirname, "..", "sites", "ysbang-hook.js"), "utf8");
const EXTRACT = HOOK.split("__YSB_MODE__").join("extract");
const extract = new Function("document", "location", EXTRACT);

function goods(n, prefix) {
  const arr = [];
  for (let i = 1; i <= n; i++) {
    arr.push({
      wholesaleid: (prefix || "w") + i,
      drugname: `${i}盒 测试药品${i} 12片*2板`,
      cn_name: "",
      manufacturer: `测试药厂${i}`,
      warehouseName: "兰州仓",
      provider_name: "某某医药",
      specification: "12片*2板",
      brand: "测试",
      minamount: 1,
      unit: "盒",
      valid_date: "2027-10-01",
    });
  }
  return arr;
}

function doc(opts) {
  const o = opts || {};
  const attrs = o.attrs || {};
  return {
    documentElement: {
      getAttribute(k) {
        return attrs[k] === undefined ? null : String(attrs[k]);
      },
    },
    getElementById(id) {
      if (id !== "__ysb_cap") return null;
      return o.payload === undefined ? null : { textContent: JSON.stringify(o.payload) };
    },
    body: { innerText: o.bodyText || "共 1234 条" },
    readyState: "complete",
  };
}

function run(payload, opts) {
  const o = opts || {};
  const hash = o.hash || "#/indexContent?searchkey=藿香正气颗粒&page=2&pagesize=60";
  const attrs = Object.assign({
    "data-ysb-hook": "1",
    "data-ysb-page": "2",
    "data-ysb-q": "藿香正气颗粒",
    "data-ysb-seq": "7",
    "data-ysb-time": String(Date.now()),
    "data-ysb-len": "60",
    "data-ysb-cap": "3",
  }, o.attrs || {});
  return extract(doc({ payload, attrs, bodyText: o.bodyText }), { hash });
}

test("正常页: 主列表 60 条, 双戳都对得上", () => {
  const r = run({ wholesales: goods(60) });
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.count, 60);
  assert.strictEqual(r.stamp.page_match, true);
  assert.strictEqual(r.stamp.q_match, true);
  assert.strictEqual(r.stamp.seq, 7);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.items[0].factory, "测试药厂1");
});

test("末页短列表不再被拒采: 7 条照常返回, 只打 warning", () => {
  const r = run({ wholesales: goods(7) });
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.count, 7);
  assert.ok(r.warnings.includes("main_list_short"), "应标记 main_list_short");
});

test("页码戳对不上: 必须报 page_mismatch 且不返回条目", () => {
  // 节点里是第 1 页的数据, 当前已经在第 2 页
  const r = run({ wholesales: goods(60) }, { attrs: { "data-ysb-page": "1" } });
  assert.strictEqual(r.reason, "page_mismatch");
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.hasList, false);
  assert.strictEqual(r.stamp.page_match, false);
});

test("关键词戳对不上: 必须报 query_mismatch(换词但 hash 未变的场景)", () => {
  const r = run({ wholesales: goods(60) }, { attrs: { "data-ysb-q": "上一个词" } });
  assert.strictEqual(r.reason, "query_mismatch");
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.stamp.q_match, false);
});

test("候选数组并列: 主列表 60 / 推荐 55 判 ambiguous, 不猜", () => {
  const r = run({ wholesales: goods(60), recommendList: goods(55) });
  assert.strictEqual(r.reason, "ambiguous");
  assert.strictEqual(r.count, 0);
  assert.ok(r.warnings.includes("ambiguous_main_list"));
  assert.strictEqual(r.candidates.length, 2);
  assert.strictEqual(r.candidates[0].key, "wholesales");
});

test("主列表明显更长: 推荐 10 条不算歧义, 取主列表", () => {
  const r = run({ wholesales: goods(60), recommendList: goods(10) });
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.count, 60);
});

test("没有捕获节点: 报 no_capture(host 据此等待重试)", () => {
  const r = run(undefined);
  assert.strictEqual(r.reason, "no_capture");
  assert.strictEqual(r.count, 0);
});
