"use strict";
/*
 * 零依赖的最小 xlsx 写入器(v1.11.0)。
 * ---------------------------------------------------------------------------
 * host 是 stdio 原生进程, 不装任何 npm 包, 所以这里手写一个合法的 .xlsx:
 *   - ZIP 用 STORE(不压缩, method 0) + CRC32, 只靠 Node 内置 Buffer。
 *   - SpreadsheetML 用内联字符串(t="inlineStr"), 避免 sharedStrings 表。
 * 产出的文件 Excel / WPS 都能直接打开。只支持单 sheet, 足够落「商品比价清单」这类表。
 *
 * 用法:
 *   const { writeSheet } = require("./xlsx");
 *   writeSheet({ file: "D:/out.xlsx", sheet: "淘宝搜同款", header: ["标题","价格","店铺"], rows: [["a",12.5,"x"]] });
 */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

// 最小 ZIP(STORE)。entries: [{ name, data:Buffer }]
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = e.data;
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lfh.writeUInt16LE(0, 8); // method: store
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, eocd]);
}

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

// 0 -> A, 25 -> Z, 26 -> AA
function colName(i) {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function cellXml(col, row, v) {
  const ref = colName(col) + row;
  if (v == null || v === "") return `<c r="${ref}"/>`;
  if (typeof v === "number" && Number.isFinite(v)) {
    return `<c r="${ref}"><v>${v}</v></c>`;
  }
  const s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
}

function sheetXml(header, rows) {
  const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
  if (header && header.length) {
    parts.push(`<row r="1">${header.map((h, i) => cellXml(i, 1, h)).join("")}</row>`);
  }
  const startRow = header && header.length ? 2 : 1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    parts.push(`<row r="${r + startRow}">${row.map((v, c) => cellXml(c, r + startRow, v)).join("")}</row>`);
  }
  parts.push("</sheetData></worksheet>");
  return Buffer.from(parts.join(""), "utf8");
}

function sanitizeSheetName(name) {
  let s = String(name || "Sheet1").replace(/[\[\]\*\\\?\/:]/g, " ").trim();
  if (!s) s = "Sheet1";
  return s.slice(0, 31);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES = `${XML}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_XML = `${XML}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="__SHEET__" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `${XML}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="1"><xf xfId="0"/></cellXfs>
</styleSheet>`;

/*
 * 生成 xlsx Buffer。opts: { sheet, header:[], rows:[[]] }
 */
function buildXlsx(opts) {
  const o = opts || {};
  const sheet = sanitizeSheetName(o.sheet);
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(WORKBOOK_XML.replace("__SHEET__", xmlEscape(sheet)), "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(WORKBOOK_RELS, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES_XML, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml(o.header || [], o.rows || []) },
  ];
  return buildZip(entries);
}

/*
 * 写盘。opts.file 必填。返回写入的绝对路径。
 */
function writeSheet(opts) {
  const fs = require("fs");
  const path = require("path");
  if (!opts || !opts.file) throw new Error("writeSheet 需要 opts.file(输出路径)");
  const file = path.resolve(String(opts.file));
  fs.writeFileSync(file, buildXlsx(opts));
  return file;
}

module.exports = { buildXlsx, writeSheet, crc32 };
