"use strict";
/*
 * 日志: stdout 被 native messaging 协议帧独占, 所以日志只走 stderr + 文件。
 * v1.6.0: 文件按大小轮转(默认 10MB), 超限改名 .1(旧的 .1 直接覆盖, 只保留一代),
 * 避免 openapi-host.log 长期运行无限膨胀。
 */
const fs = require("fs");
const path = require("path");
const { HOST_DIR } = require("./config");

const LOG_DIR = process.env.WEBTOOPENAPI_LOG_DIR || path.join(process.env.LOCALAPPDATA || HOST_DIR, "webtoopenapi", "logs");
const LOG_FILE = path.join(LOG_DIR, "openapi-host.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= MAX_LOG_BYTES) return;
    try { fs.unlinkSync(LOG_FILE + ".1"); } catch (e) { /* 没有 .1 时忽略 */ }
    fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [info] log rotated (${st.size} bytes -> openapi-host.log.1)\n`); } catch (e) { /* ignore */ }
  } catch (e) { /* 文件尚不存在或其他 IO 异常: 放行本次写入 */ }
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try { process.stderr.write(line + "\n"); } catch (e) { /* ignore */ }
  try { rotateIfNeeded(); } catch (e) { /* ignore */ }
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { /* ignore */ }
}

module.exports = { log, LOG_DIR, LOG_FILE, MAX_LOG_BYTES };
