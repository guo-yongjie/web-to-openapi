"use strict";
/*
 * HTTP(OpenAPI)服务。路由由三部分组成:
 *   1. 内置: /docs /openapi.json /api/v1/tools[/{name}] /mcp
 *   2. 站点端点: registry.allEndpoints()(新增站点自动挂载)
 *   3. 兜底 404
 */
const http = require("http");
const crypto = require("crypto");
const { CONFIG } = require("./config");
const state = require("./state");
const { log } = require("./log");
const registry = require("./registry");
const mcp = require("./mcp");
const { openApiSpec } = require("./spec");
const { docsHtml } = require("./docs");
const stats = require("./stats");
const { toolCatalog } = require("./tools");
const { withBrowserSlot, withBrowserLock, slotLimitOf, callTool } = require("./util");

let httpServer = null;
let httpPort = null;
let lastHost = null;
let lastPort = null;
let bindRetryTimer = null;

// ---------------------------------------------------------------------------
// 跨域与鉴权(2026-10-19 加固, 见 CHANGELOG v1.0.1)
// 原实现对所有响应写死 Access-Control-Allow-Origin: * 且无任何凭据校验, 等价于
// 把"浏览器全部登录态"做成对任意网页开放的接口。这里改为:
//   1) Origin 白名单: 只放行扩展自身 + localhost/+ 显式配置的 allowed_origins
//   2) 无 Origin 头的请求(本机 CLI / MCP 客户端)不适用跨域语义, 放行
//   3) 可选 Bearer token: config.json 里配了 token 才强制(默认关, 不破坏现有脚本)
// ---------------------------------------------------------------------------
const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/i;

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/+$/, "");
}

function isAllowedOrigin(origin) {
  if (!origin) return true; // 非浏览器调用
  const clean = normalizeOrigin(origin);
  const extra = CONFIG.allowed_origins || [];
  if (extra.indexOf(clean) >= 0) return true;
  if (EXT_ORIGIN_RE.test(clean)) return true; // 网页无法伪造 chrome-extension:// 这个 scheme
  return mcp.isLocalOrigin(clean); // 本机页面(/docs 自查、本机工具页)
}

function corsHeaders(echoOrigin) {
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    Vary: "Origin",
  };
  // 关键: 只回显命中的 Origin, 绝不回 "*"; 未命中则不设该头(浏览器拿不到响应体)
  if (echoOrigin) h["Access-Control-Allow-Origin"] = echoOrigin;
  return h;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? "" : a));
  const y = Buffer.from(String(b == null ? "" : b));
  if (!x.length || x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

function tokenOk(req, url) {
  if (!CONFIG.token) return true;
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1].trim() : String(url.searchParams.get("token") || "");
  return safeEqual(provided, CONFIG.token);
}

function sendJson(res, status, obj, echoOrigin) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }, corsHeaders(echoOrigin)));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error("request body too large (max 1MB)")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("invalid JSON body: " + e.message)); }
    });
    req.on("error", reject);
  });
}

// 站点端点 -> 请求处理器。GET 用查询串, POST 用 JSON body, 交给站点自己的 parse 归一化。
function endpointHandler(ep) {
  return async (ctx) => {
    const input = ctx.method === "POST" ? ctx.body : ctx.searchParams;
    const args = ep.parse ? ep.parse(input) : input;
    const run = () => ep.run(args);
    // v1.5.0: 按站点分槽(默认 1 槽 = 与旧版全局串行等价; ysbang 声明 3 槽)
    return ep.browser
      ? await withBrowserSlot((ep.site && ep.site.id) || "__browser__", slotLimitOf(ep), run)
      : await run();
  };
}

const routes = [];
function addRoute(method, path, handler) { routes.push({ method, path, handler }); }

// 路由表必须在站点注册之后构建(入口 openapi-host.js 注册完 sites 再调用本函数)。
// handleRequest 里还有一次惰性兜底, 避免漏调用时静默 404。
function buildRoutes() {
  routes.length = 0;
  for (const ep of registry.allEndpoints()) {
    const methods = ep.methods || [ep.method || "GET"];
    const h = endpointHandler(ep);
    for (const m of methods) addRoute(m, ep.path, h);
  }
  return routes.length;
}

const TOOL_PATH_RE = /^\/api\/v1\/tools\/([a-z0-9_.\-]+)$/i;

async function handleRequest(req, res) {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || "GET";

  // 1) 跨域准入: 未命中的 Origin 直接拒绝, 且不回 ACAO(浏览器读不到响应体)
  const reqOrigin = req.headers.origin;
  const echoOrigin = isAllowedOrigin(reqOrigin) ? (reqOrigin ? normalizeOrigin(reqOrigin) : null) : null;
  if (reqOrigin && !echoOrigin) {
    log("warn", `blocked cross-origin request: ${reqOrigin} -> ${pathname}`);
    return sendJson(res, 403, {
      error: "forbidden origin",
      origin: normalizeOrigin(reqOrigin),
      hint: "该服务仅接受浏览器扩展自身与本机(localhost/127.0.0.1)页面的请求。确需放行其他来源时, 在 host/config.json 的 allowed_origins 中显式添加该 Origin。",
    }, null);
  }

  const done = (status, obj) => {
    sendJson(res, status, obj, echoOrigin);
    stats.record(`${method} ${pathname}`, status, Date.now() - t0);
    log("http", `${method} ${pathname} -> ${status} (${Date.now() - t0}ms)`);
  };
  try {
    // 2) 可选 token: 配了 token 才生效; /health /stats 与 /docs 保持公开(探活与观测)
    const publicPath = pathname === "/" || pathname === "/health" || pathname === "/stats" || pathname === "/docs" || pathname === "/docs.html";
    if (!publicPath && !tokenOk(req, url)) {
      log("warn", `unauthorized request (token required): ${method} ${pathname}`);
      return done(401, {
        error: "unauthorized",
        hint: "本实例已启用 token 鉴权: 请在请求头加 Authorization: Bearer <token>, 或加查询参数 ?token=<token>。token 见 host/config.json。",
      });
    }

    if (!routes.length) buildRoutes(); // 惰性兜底: 入口漏调 buildRoutes 时不至于静默 404
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders(echoOrigin));
      return res.end();
    }
    if (method === "GET" && (pathname === "/" || pathname === "/docs" || pathname === "/docs.html")) {
      res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, corsHeaders(echoOrigin)));
      return res.end(docsHtml());
    }
    if (method === "GET" && pathname === "/openapi.json") return done(200, openApiSpec());

    // 站点端点
    const hit = routes.find((r) => r.method === method && r.path === pathname);
    if (hit) {
      const ctx = {
        method,
        searchParams: url.searchParams,
        body: method === "POST" ? await readBody(req) : {},
      };
      return done(200, await hit.handler(ctx));
    }

    if (method === "GET" && pathname === "/api/v1/tools") {
      return done(200, { tools: toolCatalog() });
    }
    const toolMatch = pathname.match(TOOL_PATH_RE);
    if (method === "POST" && toolMatch) {
      const body = await readBody(req);
      const args = body.args || body;
      const result = await withBrowserLock(() => callTool(toolMatch[1], args));
      return done(200, { name: toolMatch[1], result });
    }

    // ------------------------------------------------ MCP 服务(Streamable HTTP transport)
    if (pathname === "/mcp" || pathname === "/mcp/") {
      const origin = req.headers.origin;
      if (origin && !mcp.isLocalOrigin(origin)) {
        log("warn", `mcp request rejected: non-local Origin ${origin} (DNS rebinding guard)`);
        return done(403, { error: "forbidden origin", hint: "本 MCP 服务仅接受本地(127.0.0.1/localhost)Origin 的浏览器请求" });
      }
      if (method === "GET") {
        // 规范中 GET 用于建立 SSE 流(可选能力); 本服务不提供流, 明确告知用 POST
        res.writeHead(405, Object.assign({ "Content-Type": "application/json; charset=utf-8", Allow: "POST" }, corsHeaders(echoOrigin)));
        return res.end(JSON.stringify({ error: "SSE stream not offered", hint: "MCP Streamable HTTP: 用 POST 发送 JSON-RPC 消息到 /mcp" }));
      }
      if (method !== "POST") {
        res.writeHead(405, Object.assign({ "Content-Type": "application/json; charset=utf-8", Allow: "POST" }, corsHeaders(echoOrigin)));
        return res.end(JSON.stringify({ error: "method not allowed", allow: "POST" }));
      }
      const msg = await readBody(req);
      // session: 无状态实现(每次请求自带全部上下文), 仍按规范回一个 id 头方便客户端对齐
      const sessionId = crypto.randomUUID();
      const rpcOut = async (status, obj) => {
        stats.record("POST /mcp", status, Date.now() - t0);
        const bodyStr = JSON.stringify(obj, null, 2);
        res.writeHead(status, Object.assign({
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Expose-Headers": "Mcp-Session-Id",
          "Mcp-Session-Id": sessionId,
        }, corsHeaders(echoOrigin)));
        res.end(bodyStr);
        log("http", `MCP ${(obj && obj.result && obj.result.serverInfo) ? "initialize" : (msg && msg.method) || "?"} -> ${status}`);
      };
      try {
        const results = Array.isArray(msg) ? await Promise.all(msg.map((m) => mcp.handleRpc(m))) : [await mcp.handleRpc(msg)];
        const nonNull = results.filter((r) => r !== null);
        if (!nonNull.length) { // 全是 notification -> 202 无 body
          res.writeHead(202, { "Mcp-Session-Id": sessionId });
          return res.end();
        }
        return await rpcOut(200, Array.isArray(msg) ? nonNull : nonNull[0]);
      } catch (e) {
        return await rpcOut(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: " + e.message } });
      }
    }

    return done(404, { error: "not found", path: pathname, docs: "/docs", spec: "/openapi.json" });
  } catch (e) {
    log("error", `${method} ${pathname} failed: ${e.message}`);
    // URIError = 畸形百分号编码(如 %E4%BD 被截断) -> 属于调用方参数问题, 回 400 而非 500
    if (e instanceof URIError || e.code === "ERR_INVALID_URL") {
      return done(400, {
        error: "malformed url encoding: " + e.message,
        hint: "GET 参数必须做 URL 编码(encodeURIComponent); 中文推荐改用 POST /api/v1/search/{baidu,google} 传 JSON body。",
        path: pathname,
      });
    }
    // 站点可用 e.status 主动声明状态码(如参数校验失败抛 400), 未声明则按 500 处理
    const body = { error: e.message, path: pathname };
    if (e.needs_human) body.needs_human = true; // 503: 需要人工登录/验证, 处理后可重试
    if (e.hint) body.hint = e.hint;
    return done(Number.isFinite(e.status) ? e.status : 500, body);
  }
}

function startHttp() {
  if (httpServer && httpPort && lastHost === CONFIG.host && lastPort === CONFIG.port) return Promise.resolve(httpPort);
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    // 协议层容错: 请求行含未编码的非 ASCII 字符(典型: q=人工智能 忘了 URL 编码)时,
    // Node 的 llhttp 解析器在到达路由之前就直接 400。这里接管 clientError,
    // 返回带修复指引的 JSON, 而不是 Node 默认的纯文本 "Bad Request"。
    server.on("clientError", (err, socket) => {
      const isUrlErr = err && (err.code === "HPE_INVALID_URL" || /Invalid URL|invalid character/i.test(String(err && err.message)));
      log("warn", `clientError: ${err && err.code} ${err && err.message}${isUrlErr ? " (请求行疑似含未编码中文/特殊字符)" : ""}`);
      const payload = JSON.stringify({
        error: "bad request",
        hint: isUrlErr
          ? "请求行含未编码的非 ASCII 字符(如中文查询词)。GET 请求必须对参数做 URL 编码(encodeURIComponent), 或改用 POST /api/v1/search/{baidu,google} 传 JSON body(中文无需编码)。"
          : "malformed HTTP request",
        detail: String(err && err.message || err),
        docs: "/docs",
      });
      try {
        socket.end(
          "HTTP/1.1 400 Bad Request\r\n" +
          "Content-Type: application/json; charset=utf-8\r\n" +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          "Connection: close\r\n\r\n" +
          payload
        );
      } catch (e) { try { socket.destroy(); } catch (e2) { /* ignore */ } }
    });
    server.on("error", (e) => {
      log("error", `http bind failed on ${CONFIG.host}:${CONFIG.port} - ${e.message} (5s 后重试)`);
      reject(e);
      if (!bindRetryTimer) {
        bindRetryTimer = setInterval(() => {
          if (httpServer && httpPort && lastHost === CONFIG.host && lastPort === CONFIG.port) return;
          startHttp().catch(() => {});
        }, 5000);
      }
    });
    server.listen(CONFIG.port, CONFIG.host, () => {
      httpServer = server;
      httpPort = server.address().port;
      state.httpPort = httpPort;
      lastHost = CONFIG.host; lastPort = CONFIG.port;
      state.startedAt = new Date();
      log("info", `OpenAPI HTTP listening on http://${CONFIG.host}:${httpPort} (docs: /docs, spec: /openapi.json)`);
      resolve(httpPort);
    });
  });
}

// 按需启动: 若绑定地址变化则先停后起
function startHttpLazy() {
  if (httpServer && httpPort && lastHost === CONFIG.host && lastPort === CONFIG.port) return Promise.resolve(httpPort);
  if (httpServer) return stopHttp().then(() => startHttp());
  return startHttp();
}

function stopHttp() {
  return new Promise((resolve) => {
    if (bindRetryTimer) { clearInterval(bindRetryTimer); bindRetryTimer = null; }
    if (!httpServer) return resolve();
    httpServer.close(() => {
      log("info", "http server stopped");
      httpServer = null; httpPort = null;
      state.httpPort = null;
      resolve();
    });
    // 强制关掉保活连接
    if (httpServer.closeAllConnections) httpServer.closeAllConnections();
  });
}

module.exports = { startHttp, startHttpLazy, stopHttp, handleRequest, sendJson, readBody, buildRoutes, routes };
