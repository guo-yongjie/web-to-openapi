"use strict";
/*
 * 安全回归测试(v1.0.1 加固)
 * ---------------------------------------------------------------------------
 * 目的: 锁死"任意网页跨域调用本地服务"这条路径, 防止后续改动回退。
 * 运行: node --test host/test/
 * 特点: 不需要启动 HTTP 服务、不需要浏览器扩展连接, 直接对 handleRequest 打桩调用。
 */
const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");

const httpSvc = require("../lib/http");
const { CONFIG } = require("../lib/config");

// 测试必须与本机配置隔离: v1.7.1 起 host/config.json 默认带 token,
// 若直接沿用会让一半用例莫名 401。这里清空, 由各 token 用例自己开关。
CONFIG.token = "";

require("../sites"); // 注册站点路由(含 /health)
httpSvc.buildRoutes();

const EVIL = "https://evil.example.com";
const LOCAL = "http://127.0.0.1:8090";
const EXT = "chrome-extension://bjgdikingllkajknbjlopfmhgpcjponf";

// 构造最小 req/res 桩, 直接打 handleRequest
function call(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = o.method || "GET";
    req.url = o.url || "/health";
    req.headers = o.headers || {};
    if (o.body !== undefined) req.push(typeof o.body === "string" ? o.body : JSON.stringify(o.body));
    req.push(null);

    const chunks = [];
    const res = {
      statusCode: null,
      headers: {},
      writeHead(code, h) {
        this.statusCode = code;
        this.headers = h || {};
      },
      end(b) {
        if (b) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)));
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: Buffer.concat(chunks).toString(),
        });
      },
    };
    httpSvc.handleRequest(req, res).catch((e) =>
      resolve({ status: 500, headers: {}, body: String(e && e.message) })
    );
  });
}

const acao = (r) => r.headers["Access-Control-Allow-Origin"];

// ---------------------------------------------------------------------------
test("P0 回归: 恶意 Origin 调工具透传端点被拒, 且不回 ACAO", async () => {
  const r = await call({
    method: "POST",
    url: "/api/v1/tools/get_windows_and_tabs",
    headers: { origin: EVIL, "content-type": "application/json" },
    body: { args: {} },
  });
  assert.strictEqual(r.status, 403, "应返回 403");
  assert.strictEqual(acao(r), undefined, "不得回 ACAO, 否则浏览器仍可读响应");
  assert.match(r.body, /forbidden origin/);
});

test("P0 回归: 恶意 Origin 的预检请求被拒", async () => {
  const r = await call({
    method: "OPTIONS",
    url: "/api/v1/tools/chrome_javascript",
    headers: { origin: EVIL, "access-control-request-method": "POST" },
  });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(acao(r), undefined);
});

test("P0 回归: 恶意 Origin 读站点端点/工具目录同样被拒", async () => {
  for (const url of ["/api/v1/tools", "/health", "/openapi.json", "/docs"]) {
    const r = await call({ url, headers: { origin: EVIL } });
    assert.strictEqual(r.status, 403, `${url} 应被拒`);
    assert.strictEqual(acao(r), undefined, `${url} 不得回 ACAO`);
  }
});

// ---------------------------------------------------------------------------
test("正常路径: 本机页面 Origin 放行, 且 ACAO 精确回显(不是 *)", async () => {
  const r = await call({ url: "/health", headers: { origin: LOCAL } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(acao(r), LOCAL);
  assert.notStrictEqual(acao(r), "*", "绝不回通配");
  assert.strictEqual(r.headers["Vary"], "Origin");
});

test("正常路径: 扩展自身 Origin 放行(预检与实调)", async () => {
  const pre = await call({ method: "OPTIONS", url: "/api/v1/tools", headers: { origin: EXT } });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(acao(pre), EXT);

  const real = await call({ url: "/health", headers: { origin: EXT } });
  assert.strictEqual(real.status, 200);
  assert.strictEqual(acao(real), EXT);
});

test("正常路径: 无 Origin 的本机调用(CLI / MCP 客户端)不被误伤", async () => {
  const r = await call({ url: "/health" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(acao(r), undefined, "无 Origin 时不写 ACAO 即可, 不影响非浏览器调用");
});

test("正常路径: localhost 与 ::1 等价放行", async () => {
  for (const o of ["http://localhost:8090", "http://[::1]:8090"]) {
    const r = await call({ url: "/health", headers: { origin: o } });
    assert.strictEqual(r.status, 200, `${o} 应放行`);
  }
});

// ---------------------------------------------------------------------------
test("token 开关: 未配置 token 时不要求凭据(默认行为不变)", async () => {
  CONFIG.token = "";
  const r = await call({ method: "POST", url: "/api/v1/tools", headers: { "content-type": "application/json" }, body: {} });
  assert.notStrictEqual(r.status, 401, "未启用 token 时不应 401");
});

test("token 开关: 配置后缺 token 得 401, 带对 token 放行", async () => {
  const saved = CONFIG.token;
  CONFIG.token = "test-token-abc";
  try {
    const bad = await call({ method: "POST", url: "/api/v1/tools", headers: { "content-type": "application/json" }, body: {} });
    assert.strictEqual(bad.status, 401);

    const good = await call({
      method: "POST",
      url: "/api/v1/tools",
      headers: { "content-type": "application/json", authorization: "Bearer test-token-abc" },
      body: {},
    });
    assert.notStrictEqual(good.status, 401, "正确 token 应放行");

    const viaQuery = await call({ method: "POST", url: "/api/v1/tools?token=test-token-abc", headers: { "content-type": "application/json" }, body: {} });
    assert.notStrictEqual(viaQuery.status, 401, "查询参数 token 应放行");

    const publicOk = await call({ url: "/health" });
    assert.strictEqual(publicOk.status, 200, "/health 保持公开(探活)");
  } finally {
    CONFIG.token = saved;
  }
});

// v1.7.1: 锁死公开路径清单 —— 防止将来新增端点被顺手加进 publicPath 而绕开鉴权。
test("token 生效时: 仅 /health /docs /stats 公开, /mcp 与所有业务端点必须带凭据", async () => {
  const saved = CONFIG.token;
  CONFIG.token = "test-token-abc";
  try {
    for (const p of ["/health", "/docs", "/stats", "/"]) {
      const r = await call({ url: p });
      assert.notStrictEqual(r.status, 401, `${p} 应保持公开`);
    }
    for (const p of ["/mcp", "/api/v1/tools", "/api/v1/ysbang/price", "/openapi.json"]) {
      const r = await call({ method: "POST", url: p, headers: { "content-type": "application/json" }, body: {} });
      assert.strictEqual(r.status, 401, `${p} 必须要求凭据(新端点不要加进 publicPath)`);
    }
  } finally {
    CONFIG.token = saved;
  }
});
