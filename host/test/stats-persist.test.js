"use strict";
/*
 * v1.6.0 新增能力回归:
 *   1) /stats 端点: HTTP 层请求数据被记录, 观测含药师帮缓存/熔断状态
 *   2) ysbang-store 落盘持久化: 缓存条目与熔断冷却写入 json,
 *      新进程加载模块时能恢复缓存与冷却状态(用子进程绕过 require 缓存验证)
 * 注意: 本文件在所有 host 模块加载前把 LOCALAPPDATA 指向临时目录,
 *       持久化/日志全部落在临时区, 不碰真实 %LOCALAPPDATA%。
 * 运行: node --test host/test/*.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// ⚠ 必须在 require 任何 host 模块之前: config.js 在 require 时读取 LOCALAPPDATA
const TMP_APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "wto-test-"));
process.env.LOCALAPPDATA = TMP_APPDATA;

const fake = require("./helpers/fake-browser").install({});
const registry = require("../lib/registry");
const httpSvc = require("../lib/http");
require("../sites");
httpSvc.buildRoutes();
const store = require("../sites/ysbang-store");

const ep = (p) => registry.allEndpoints().find((e) => e.path === p);

// 构造最小 req/res 桩, 直接打 handleRequest(与 security.test.js 同款)
function call(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const req = new (require("node:stream").Readable)({ read() {} });
    req.method = o.method || "GET";
    req.url = o.url || "/health";
    req.headers = o.headers || {};
    if (o.body !== undefined) req.push(typeof o.body === "string" ? o.body : JSON.stringify(o.body));
    req.push(null);
    const chunks = [];
    const res = {
      statusCode: null,
      headers: {},
      writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
      end(b) {
        if (b) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)));
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks).toString() });
      },
    };
    httpSvc.handleRequest(req, res).catch((e) => resolve({ status: 500, headers: {}, body: String(e && e.message) }));
  });
}

test("/stats: 记录 HTTP 层调用统计, 返回药师帮缓存/熔断观测", async () => {
  // 先造一次真实路由调用(走假浏览器, 不发网络)
  const price = ep("/api/v1/ysbang/price");
  const p = price.parse(new URLSearchParams("q=观测测试品种&mode=cheapest&pages=1&ttl=0"));
  await price.run(p);

  const r = await call({ method: "GET", url: "/stats" });
  assert.strictEqual(r.status, 200, "/stats 可公开访问");
  const out = JSON.parse(r.body);
  assert.ok(out.requests && Array.isArray(out.requests.endpoints), "requests.endpoints 数组");

  // 响应体在 done 记录之前生成, 所以响应里看不到"自己这次"; 再调一次, 应能看到第一次
  const r2 = await call({ method: "GET", url: "/stats" });
  const out2 = JSON.parse(r2.body);
  const statCalls = out2.requests.endpoints.filter((x) => x.label === "GET /stats");
  assert.strictEqual(statCalls.length, 1, "前一次 /stats 调用已被记录");
  assert.strictEqual(statCalls[0].count, 1, "count=1(第二次调用自身的记录发生在响应生成之后)");

  assert.ok(out.ysbang && out.ysbang.cache && out.ysbang.block, "含 ysbang 缓存/熔断观测");
  assert.ok(out.ysbang.cache.puts >= 1, "刚才那次查询写入了缓存");
  assert.ok(out.ysbang.cache.persist_file.startsWith(TMP_APPDATA), "持久化文件在临时区");
});

test("ysbang-store: 熔断落盘后, 新进程能恢复冷却与缓存", async () => {
  store.resetForTest();
  // 写入: 一条缓存 + 一次熔断
  const payload = { items: [{ name: "持久化测试", price: 1 }], count: 1 };
  store.cachePut({ mode: "cheapest", q: "持久化测试", pages: 1, sort: "", top: 0 }, payload);
  store.markBlocked("测试");
  await store.saveNow();

  const raw = JSON.parse(fs.readFileSync(store.STATE_FILE, "utf8"));
  assert.ok(raw.block.until > Date.now(), "冷却未过期地写进了文件");

  // 新进程加载同一模块(同一 LOCALAPPDATA -> 同一 STATE_FILE), stats() 应恢复两样东西
  const modulePath = path.join(__dirname, "..", "sites", "ysbang-store.js").replace(/\\/g, "/");
  const script = `const s = require(${JSON.stringify(modulePath)});` +
    `const st = s.stats(); console.log(JSON.stringify({size: st.cache.size, blocked: st.block.blocked, remaining_s: st.block.remaining_s, hits_total: st.block.hits_total}));`;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, LOCALAPPDATA: TMP_APPDATA },
    encoding: "utf8",
  }));
  assert.ok(out.size >= 1, `新进程恢复缓存条目(得到 ${out.size})`);
  assert.strictEqual(out.blocked, true, "新进程恢复熔断冷却");
  assert.ok(out.remaining_s > 0, "冷却剩余时间为正");
  assert.strictEqual(out.hits_total, 1, "累计命中次数恢复");

  // 清场: 别把测试熔断留给真实服务
  store.resetForTest();
  store.saveNow();
});
