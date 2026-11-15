"use strict";
/*
 * xlsx 写入器单测(v1.11.0)
 * 不依赖外部库, 校验:
 *   - 产出合法 zip 骨架(PK 魔数 + EOCD + 6 个标准条目)
 *   - 内联字符串 XML 转义(& < > " ' 控制字符)
 *   - 数字走 <v>, 空值走空 <c>
 *   - writeSheet 落盘并写回可读
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildXlsx, writeSheet, crc32 } = require("../lib/xlsx");

test("buildXlsx: PK 魔数 + 6 个标准条目", () => {
  const buf = buildXlsx({ sheet: "Sheet1", header: ["a"], rows: [["b"]] });
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, "开头必须是 local file header 魔数");
  const text = buf.toString("latin1");
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(text.indexOf(name) >= 0, "缺少条目: " + name);
  }
  // EOCD 魔数(0x06054b50)在文件末尾 22 字节处
  assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50, "末尾必须是 EOCD");
});

test("buildXlsx: 内联字符串做 XML 转义", () => {
  const buf = buildXlsx({ header: ["标题"], rows: [['A<B & "C" \'D\'']] });
  const xml = buf.toString("utf8");
  assert.ok(xml.indexOf("A&lt;B &amp; &quot;C&quot; &apos;D&apos;") >= 0, "特殊字符必须被转义");
});

test("buildXlsx: 数字走 <v>, 空值走空 <c/>, 布尔转 TRUE/FALSE", () => {
  const buf = buildXlsx({ header: ["h"], rows: [[12.5, null, true, ""]] });
  const xml = buf.toString("utf8");
  assert.ok(xml.indexOf("<v>12.5</v>") >= 0, "数字应走数值单元格");
  assert.ok(xml.indexOf("<c r=") >= 0);
  assert.ok(xml.indexOf("TRUE") >= 0);
});

test("buildXlsx: 表名非法字符被清洗", () => {
  const buf = buildXlsx({ sheet: "a/b:c*", header: [], rows: [] });
  const xml = buf.toString("utf8");
  assert.ok(xml.indexOf("<sheet name=\"a b c\"") >= 0, "[/\\*?:] 应被替换为空格");
});

test("writeSheet: 落盘成功且内容可读回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-xlsx-"));
  const file = path.join(dir, "out.xlsx");
  const out = writeSheet({ file, sheet: "淘宝搜同款", header: ["标题", "价格"], rows: [["氨糖软骨素", 68]] });
  assert.strictEqual(out, file);
  const back = fs.readFileSync(file);
  assert.strictEqual(back.readUInt32LE(0), 0x04034b50);
  assert.ok(back.toString("utf8").indexOf("氨糖软骨素") >= 0);
});

test("crc32: 已知向量", () => {
  // crc32("123456789") 的经典值是 0xCBF43926
  assert.strictEqual(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
});
