/**
 * 读取 xlsx 工作表为二维数据。
 * 同时支持本项目生成的 inlineStr 与 Excel 另存后的 sharedStrings 两种写法。
 */
const { readZip } = require('./zipread');

const unesc = s => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

function textOf(fragment) {
  // 拼接所有 <t>…</t>，兼容富文本 <r><t>
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(fragment))) out += m[1];
  return unesc(out);
}

function parseSharedStrings(xml) {
  const list = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) list.push(textOf(m[1]));
  return list;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = {};
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
      let val = '';
      if (type === 's') {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = v !== undefined ? (shared[Number(v)] ?? '') : '';
      } else if (type === 'inlineStr') {
        val = textOf(body);
      } else if (type === 'str') {
        val = unesc((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      } else {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = v !== undefined ? unesc(v) : '';
      }
      cells[ref] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/** Excel 日期序列号（如 46328）→ YYYY-MM-DD；非日期原样返回 */
function excelDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
      const p = x => String(x).padStart(2, '0');
      return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    }
  }
  return s;
}

function readSheet(file, sheetName = 'xl/worksheets/sheet1.xml') {
  const z = readZip(file);
  const shared = z['xl/sharedStrings.xml'] ? parseSharedStrings(z['xl/sharedStrings.xml'].toString('utf8')) : [];
  const xml = z[sheetName];
  if (!xml) throw new Error('缺少 ' + sheetName);
  return { rows: parseSheet(xml.toString('utf8'), shared), entries: z };
}

module.exports = { readSheet, parseSheet, parseSharedStrings, unesc, excelDate };
