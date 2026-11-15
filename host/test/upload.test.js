"use strict";
/*
 * upload 文件上传动作单测(v1.11.0)
 * 全程 mock util.callTool, 不碰真浏览器。
 * 覆盖:
 *   - 缺 file_path -> 400
 *   - 不传 ref 自动枚举: 1 个直接用 / 0 个 hint=no_file_input / 多个 hint=multiple_file_inputs
 *   - 传 ref: 非文件框拒绝 / DOCUMENT_CHANGED 失效
 *   - 派发成功走 chrome_upload_file(selector+filePath+tabId), 回执 input_kind=trusted
 *   - 超时 -> dispatched:"unknown" 且 retryable:false
 */
const test = require("node:test");
const assert = require("node:assert");
const util = require("../lib/util");
const action = require("../lib/action");

const TAB = 77;
let calls = [];

function reply(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function page(obj) {
  return reply({ success: true, tabId: TAB, result: obj });
}

const CHANGED = { verdict: "changed", signal: "url_changed", elapsed_ms: 320, checks: [], alive: true };
const CALLS = (n) => calls.filter((c) => c.name === n).length;

function mock(impl) {
  calls = [];
  const up = impl.upload || "ok";
  util.callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "chrome_upload_file") {
      if (impl.uploadFn) return reply(impl.uploadFn(args));
      if (up === "timeout") throw new Error("tool call timed out after 60000ms: chrome_upload_file");
      if (up === "error") return { content: [{ type: "text", text: "Error uploading file: bad input" }], isError: true };
      return reply({ success: true, message: "File(s) uploaded successfully", files: [args.filePath], selector: args.selector, fileCount: 1 });
    }
    if (name !== "chrome_javascript") throw new Error("unexpected tool: " + name);
    const code = args.code || "";
    if (code.indexOf("input[type=file]") >= 0) return page(impl.fileInputs ? impl.fileInputs() : { tok: "p1a", count: 0, inputs: [] });
    if (code.indexOf("NOT_FILE_INPUT") >= 0) return page(impl.fileResolve ? impl.fileResolve() : {});
    if (code.indexOf("var LIMIT =") >= 0) return page(impl.settle ? impl.settle() : { verdict: "none", checks: [] });
    throw new Error("unrecognized injected script");
  };
}

const ONE_INPUT = () => ({
  tok: "p1a",
  snap: { uh: 111, path: "/", mut: 5, ready: "complete" },
  count: 1,
  inputs: [{ ref: "p1a.r7", selector: "#imgfile", visible: false, accept: "image/*", multiple: false, name: "imgfile", id: "imgfile" }],
});

const RESOLVE_FILE = () => ({
  ok: true, tok: "p1a", ref: "p1a.r7", selector: "#imgfile", tag: "input", type: "file", visible: false,
  snap: { uh: 111, path: "/", mut: 5, ready: "complete" }, base: { value: null, checked: null, disabled: false },
});

test("upload: 缺少 file_path -> 400, 不碰浏览器", async () => {
  mock({});
  await assert.rejects(() => action.upload({}), (e) => e.status === 400);
  assert.strictEqual(calls.length, 0);
});

test("upload(不传 ref, 1 个文件框): 自动上传, 回执 trusted+changed", async () => {
  mock({ fileInputs: ONE_INPUT, settle: () => CHANGED });
  const r = await action.upload({ file_path: "D:/产品图.jpg", expect: [{ expect: "url", value: "/search" }] });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.mechanism, "upload");
  assert.strictEqual(r.input_kind, "trusted");
  assert.strictEqual(r.effect.verdict, "changed");
  assert.strictEqual(r.target.selector, "#imgfile");
  const ups = calls.filter((c) => c.name === "chrome_upload_file");
  assert.strictEqual(ups.length, 1);
  assert.strictEqual(ups[0].args.selector, "#imgfile");
  assert.strictEqual(ups[0].args.filePath, "D:/产品图.jpg");
});

test("upload(不传 ref, 0 个文件框): hint=no_file_input, 不派发", async () => {
  mock({ fileInputs: () => ({ tok: "p1a", count: 0, inputs: [], snap: { uh: 111 } }) });
  const r = await action.upload({ file_path: "D:/a.jpg" });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.hint, "no_file_input");
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(CALLS("chrome_upload_file"), 0, "没找到文件框绝不派发上传");
});

test("upload(不传 ref, 多个文件框): hint=multiple_file_inputs, 要求显式传 ref", async () => {
  mock({
    fileInputs: () => ({
      tok: "p1a", count: 2, snap: { uh: 111 },
      inputs: [
        { ref: "p1a.r1", selector: "#a", accept: "image/*" },
        { ref: "p1a.r2", selector: "#b", accept: "video/*" },
      ],
    }),
  });
  const r = await action.upload({ file_path: "D:/a.jpg" });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.hint, "multiple_file_inputs");
  assert.match(r.note, /候选/);
  assert.strictEqual(CALLS("chrome_upload_file"), 0);
});

test("upload(传 ref, 但不是文件框): 拒绝并说明", async () => {
  mock({ fileResolve: () => ({ ok: false, why: "NOT_FILE_INPUT", tok: "p1a", tag: "div", type: null }) });
  const r = await action.upload({ ref: "p1a.r3", page_token: "p1a", file_path: "D:/a.jpg" });
  assert.strictEqual(r.dispatched, false);
  assert.match(r.note, /不是文件输入框/);
  assert.strictEqual(CALLS("chrome_upload_file"), 0);
});

test("upload(传 ref, 页面换文档): stale=DOCUMENT_CHANGED", async () => {
  mock({ fileResolve: () => ({ ok: false, why: "DOCUMENT_CHANGED", tok: "p9z" }) });
  const r = await action.upload({ ref: "p1a.r7", page_token: "p1a", file_path: "D:/a.jpg" });
  assert.strictEqual(r.stale, "DOCUMENT_CHANGED");
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(CALLS("chrome_upload_file"), 0);
});

test("upload(传 ref, 合法文件框): 用 ref 解析出的 selector 上传", async () => {
  mock({ fileResolve: RESOLVE_FILE, settle: () => CHANGED });
  const r = await action.upload({ ref: "p1a.r7", page_token: "p1a", file_path: "D:/a.jpg" });
  assert.strictEqual(r.dispatched, true);
  const ups = calls.filter((c) => c.name === "chrome_upload_file");
  assert.strictEqual(ups[0].args.selector, "#imgfile");
});

test("upload: 上传超时 -> dispatched=unknown, retryable=false, 不重试", async () => {
  mock({ fileInputs: ONE_INPUT, upload: "timeout" });
  const r = await action.upload({ file_path: "D:/a.jpg" });
  assert.strictEqual(r.dispatched, "unknown");
  assert.strictEqual(r.retryable, false);
  assert.match(r.note, /二次上传风险/);
  assert.strictEqual(CALLS("chrome_upload_file"), 1, "超时后绝不二次派发");
});

test("upload: 上传报错 -> dispatched=false, 可重试", async () => {
  mock({ fileInputs: ONE_INPUT, upload: "error" });
  const r = await action.upload({ file_path: "D:/a.jpg" });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.retryable, true);
  assert.match(r.note, /上传失败/);
});
