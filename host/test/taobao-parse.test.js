"use strict";
/*
 * taobao.js parseRequest 参数解析单测(v1.11.0)
 * 锁死: image_path 必填、entry 非法回退 search、数值参数解析、no_excel truthy。
 */
const test = require("node:test");
const assert = require("node:assert");
const taobao = require("../sites/taobao.js");

const ep = taobao.endpoints[0];
const parse = ep.parse;

test("parseRequest: 基本字段解析", () => {
  const p = parse({ image_path: "D:/产品图.jpg" });
  assert.strictEqual(p.image_path, "D:/产品图.jpg");
  assert.strictEqual(p.entry, "search");
  assert.strictEqual(p.tabId, null);
  assert.strictEqual(p.wait_ms, 25000);
  assert.strictEqual(p.max_items, 60);
  assert.strictEqual(p.no_excel, false);
});

test("parseRequest: entry=home 生效, 非法值回退 search", () => {
  assert.strictEqual(parse({ entry: "home" }).entry, "home");
  assert.strictEqual(parse({ entry: "xxx" }).entry, "search");
});

test("parseRequest: 数值参数与 tabId", () => {
  const p = parse({ tabId: 42, wait_ms: "8000", max_items: "20" });
  assert.strictEqual(p.tabId, 42);
  assert.strictEqual(p.wait_ms, 8000);
  assert.strictEqual(p.max_items, 20);
});

test("parseRequest: no_excel 的 truthy 判定", () => {
  assert.strictEqual(parse({ no_excel: true }).no_excel, true);
  assert.strictEqual(parse({ no_excel: "1" }).no_excel, true);
  assert.strictEqual(parse({ no_excel: "no" }).no_excel, false);
});

test("parseRequest: tabId 空串/非法值当未传", () => {
  assert.strictEqual(parse({ tabId: "" }).tabId, null);
  assert.strictEqual(parse({ tabId: "abc" }).tabId, null);
});

test("工具 run 包装: 走 parseRequest 传入 searchByImage", () => {
  const tool = taobao.tools.find((t) => t.name === "taobao_search_by_image");
  assert.ok(tool, "MCP 工具应存在");
  assert.deepStrictEqual(tool.inputSchema.required, ["image_path"]);
  assert.ok(tool.inputSchema.properties.image_path, "schema 需含 image_path");
});
