/**
 * 极简 xlsx 生成器（零依赖）
 * 复用原模板的设计样式，只重写三张工作表与表格定义。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------- ZIP ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zipArchive(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(raw);
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = comp.length < raw.length;
    const data = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------------- helpers ----------------
const escXml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return w;
}

// 单元格样式索引
const S_HEAD = 1;      // 表头
const S_BODY = 3;      // 正文
const S_NUM = 10;      // 数字居中
const S_PCT = 11;      // 百分比
const S_TITLE = 4;
const S_LABEL = 7;
const S_TEXT = 8;
const S_NOTE = 9;

const COLS = [
  { name: '单词', width: 18 },
  { name: '音标', width: 20 },
  { name: '词性', width: 10 },
  { name: '核心释义', width: 34 },
  { name: '熟词僻义/拓展义', width: 42 },
  { name: '派生词/词形', width: 30 },
  { name: '词频排名', width: 9 },
  { name: '参考词频', width: 10 },
  { name: '掌握状态', width: 10 },
  { name: '最近复习日期', width: 14 },
  { name: '个人备注', width: 24 }
];
const COL_LETTER = 'ABCDEFGHIJK'.split('');

function buildSheet1(words, statusMap) {
  const rows = [];
  // 表头
  rows.push(
    '<row r="1" ht="30" customHeight="1">' +
    COLS.map((c, i) =>
      `<c r="${COL_LETTER[i]}1" s="${S_HEAD}" t="inlineStr"><is><t>${escXml(c.name)}</t></is></c>`
    ).join('') + '</row>'
  );

  words.forEach((w, idx) => {
    const r = idx + 2;
    const st = statusMap[w.word] || {};
    const cells = [];
    const put = (col, val, style) => {
      if (val === undefined || val === null || val === '') return;
      if (typeof val === 'number') cells.push(`<c r="${col}${r}" s="${style}"><v>${val}</v></c>`);
      else cells.push(`<c r="${col}${r}" s="${style}" t="inlineStr"><is><t>${escXml(val)}</t></is></c>`);
    };
    put('A', w.word, S_BODY);
    put('B', w.phonetic, S_BODY);
    put('C', w.pos, S_BODY);
    put('D', w.meaning, S_BODY);
    put('E', w.extra, S_BODY);
    put('F', w.family, S_BODY);
    put('G', w.rank, S_NUM);
    put('H', w.freq, S_NUM);
    put('I', st.status || '未学习', S_BODY);
    put('J', st.date, S_BODY);
    put('K', st.note, S_BODY);

    // 行高自适应（按最长单元格估算换行数）
    let lines = 1;
    for (let i = 0; i < COLS.length; i++) {
      const v = [w.word, w.phonetic, w.pos, w.meaning, w.extra, w.family, '', '', st.status, st.date, st.note][i];
      if (!v || typeof v === 'number') continue;
      const per = Math.max(4, COLS[i].width - 1);
      lines = Math.max(lines, Math.ceil(dispWidth(v) / per));
    }
    const ht = Math.min(Math.max(20, lines * 15 + 4), 96);
    rows.push(`<row r="${r}" ht="${ht}" customHeight="1">${cells.join('')}</row>`);
  });

  const last = words.length + 1;
  const cols = COLS.map((c, i) =>
    `<col width="${c.width}" customWidth="1" min="${i + 1}" max="${i + 1}"/>`
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr><dimension ref="A1:K${last}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData><conditionalFormatting sqref="I2:I${last}"><cfRule type="expression" priority="1" dxfId="0"><formula>I2="认识"</formula></cfRule><cfRule type="expression" priority="2" dxfId="1"><formula>I2="模糊"</formula></cfRule><cfRule type="expression" priority="3" dxfId="2"><formula>I2="不认识"</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation sqref="I2:I${last}" showDropDown="0" showInputMessage="1" showErrorMessage="1" allowBlank="1" errorTitle="状态无效" error="请从下拉选项中选择掌握状态。" promptTitle="掌握状态" prompt="选择 未学习 / 认识 / 模糊 / 不认识。" type="list"><formula1>"未学习,认识,模糊,不认识"</formula1></dataValidation></dataValidations><pageMargins left="0.5" right="0.5" top="0.8" bottom="0.8" header="0.3" footer="0.3"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`;
}

function buildSheet2(count, meta) {
  const R = `'5500词总表'`;
  const line = (r, a, b, styleB) =>
    `<row r="${r}" ht="26" customHeight="1"><c r="A${r}" s="${S_LABEL}" t="inlineStr"><is><t>${escXml(a)}</t></is></c>` +
    (typeof b === 'number' || b === undefined ? '' : '') +
    `<c r="B${r}" s="${styleB || S_TEXT}">${b}</c></row>`;

  const fmtRow = (r, label, formula, kind) => {
    const s = kind === 'pct' ? S_PCT : kind === 'num' ? S_NUM : S_TEXT;
    return `<row r="${r}" ht="26" customHeight="1"><c r="A${r}" s="${S_LABEL}" t="inlineStr"><is><t>${escXml(label)}</t></is></c><c r="B${r}" s="${s}"><f>${escXml(formula)}</f></c></row>`;
  };
  const last = count + 1;

  const statRows = [
    fmtRow(3, '已录入单词数', `COUNTA(${R}!A2:A${last})`, 'num'),
    fmtRow(4, '认识', `COUNTIF(${R}!I2:I${last},"认识")`, 'num'),
    fmtRow(5, '模糊', `COUNTIF(${R}!I2:I${last},"模糊")`, 'num'),
    fmtRow(6, '不认识', `COUNTIF(${R}!I2:I${last},"不认识")`, 'num'),
    fmtRow(7, '未学习', `COUNTIF(${R}!I2:I${last},"未学习")`, 'num'),
    fmtRow(8, '完成率', `IF(B3=0,0,(B4+B5+B6)/B3)`, 'pct'),
    fmtRow(9, '已掌握率（认识/总数）', `IF(B3=0,0,B4/B3)`, 'pct'),
    `<row r="10" ht="26" customHeight="1"><c r="A10" s="${S_LABEL}" t="inlineStr"><is><t>下一步建议</t></is></c><c r="B10" s="${S_TEXT}"><f>IF(B8&lt;0.5,"先按 G 列升序打通高频词（前 1500 个覆盖大部分真题）","在总表筛选“模糊”和“不认识”集中复习")</f></c></row>`
  ].join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr><dimension ref="A1:B10"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews><sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><cols><col width="26" customWidth="1" min="1" max="1"/><col width="86" customWidth="1" min="2" max="2"/></cols><sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="${S_TITLE}" t="inlineStr"><is><t>考研英语二 5500 词 · 学习统计</t></is></c></row><row r="2" ht="24" customHeight="1"><c r="A2" s="${S_HEAD}" t="inlineStr"><is><t>统计项目</t></is></c><c r="B2" s="${S_HEAD}" t="inlineStr"><is><t>数值 / 说明</t></is></c></row>${statRows}</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="0.7" right="0.7" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>`;
}

function buildSheet3(meta) {
  const rows = [];
  const push = (label, text, h) => {
    const r = rows.length + 1;
    const ht = h || Math.max(28, Math.ceil(dispWidth(text) / 96) * 18 + 10);
    rows.push(
      `<row r="${r}" ht="${ht}" customHeight="1">` +
      `<c r="A${r}" s="${S_LABEL}" t="inlineStr"><is><t>${escXml(label)}</t></is></c>` +
      `<c r="B${r}" s="${S_NOTE}" t="inlineStr"><is><t>${escXml(text)}</t></is></c></row>`
    );
  };
  push('当前版本', `完整词库 ${meta.count} 词，已通过自动校验（见 校验报告.md）。词表＝${meta.sourceShort}。`);
  push('词表来源', '2024 考研英语（一/二）考试大纲词汇表 5530 词；释义与词频来自 exam-data/NETEMVocabulary（CC BY-NC-SA 4.0）；音标、义项、词形来自 ECDICT（MIT）。英语一、英语二共用同一套大纲词汇表。');
  push('字段说明', '音标、词性、核心释义、熟词僻义/拓展义（ECDICT 中未被核心释义覆盖的义项）、派生词/词形（过去式、分词、复数等）、词频排名（1=最高频）、参考词频（200 套真题语料出现次数）。');
  push('掌握状态', '在 I 列下拉选择：未学习 / 认识 / 模糊 / 不认识。颜色会自动变化，学习统计页同步更新。');
  push('按词频背', '按 G 列升序排序，前 1500 个词覆盖绝大部分真题文本；也可以直接用 HTML 工具的“高频优先”模式。');
  push('筛选错词', '点标题行筛选 I 列“模糊”或“不认识”，即可得到待复习清单。');
  push('与 HTML 同步', '两个文件共用同一份数据源 data/words.json。HTML 内置词库，无需导入 CSV。学习进度可互通：Excel 另存为 CSV UTF-8 → HTML 点“导入学习记录”；反向则用 HTML “导出学习记录”得到 CSV，在 Excel 中粘贴回 I/J/K 列。');
  push('重建词库', '修改 data/words.json 后在命令行运行 node tools/build.js（会保留 Excel 里已有的掌握状态/备注），再运行 node tools/validate.js 校验。');
  push('备份', 'HTML 进度存在浏览器本地，建议每周点一次“导出完整备份”。重新生成工作簿前，脚本会自动把旧文件备份到 data/backup/。');
  push('注意', '本表只保证词表完整性与释义来源可追溯；学习节奏、释义取舍仍以你自己和真题语境为准。');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr><dimension ref="A1:B${rows.length}"/><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><cols><col width="22" customWidth="1" min="1" max="1"/><col width="100" customWidth="1" min="2" max="2"/></cols><sheetData><row r="1" ht="34" customHeight="1"><c r="A1" s="${S_TITLE}" t="inlineStr"><is><t>考研英语二 5500 词 · 使用说明</t></is></c></row>${rows.join('')}</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="0.7" right="0.7" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>`;
}

function buildTable(count) {
  const last = count + 1;
  const cols = COLS.map((c, i) => `<tableColumn id="${i + 1}" name="${escXml(c.name)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="VocabularyTable" displayName="VocabularyTable" ref="A1:K${last}" totalsRowShown="0"><autoFilter ref="A1:K${last}"/><tableColumns count="${COLS.length}">${cols}</tableColumns><tableStyleInfo name="TableStyleMedium2" showRowStripes="1" showColumnStripes="0"/></table>`;
}

function buildWorkbook(meta) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000" activeTab="0"/></bookViews><sheets><sheet name="5500词总表" sheetId="1" r:id="rId1"/><sheet name="学习统计" sheetId="2" r:id="rId2"/><sheet name="使用说明" sheetId="3" r:id="rId3"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'5500词总表'!$A$1:$K$${meta.count + 1}</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
}

function patchStyles(baseStyles) {
  let s = baseStyles;
  // 追加 2 个 xf：10 居中数字，11 百分比
  s = s.replace('</cellXfs>',
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="2" applyAlignment="1" pivotButton="0" quotePrefix="0" xfId="0"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="10" fontId="2" fillId="0" borderId="2" applyAlignment="1" applyNumberFormat="1" pivotButton="0" quotePrefix="0" xfId="0"><alignment horizontal="center" vertical="center"/></xf>' +
    '</cellXfs>');
  s = s.replace(/<cellXfs count="(\d+)">/, (m, n) => `<cellXfs count="${Number(n) + 2}">`);
  return s;
}

/**
 * @param {string} outPath
 * @param {object} opts { words, statusMap, meta, templateDir }
 */
function writeWorkbook(outPath, opts) {
  const { words, statusMap, meta, templateDir } = opts;
  const read = f => fs.readFileSync(path.join(templateDir, f), 'utf8');

  const files = [
    { name: '[Content_Types].xml', data: read('[Content_Types].xml') },
    { name: '_rels/.rels', data: read('_rels/.rels') },
    { name: 'docProps/app.xml', data: read('docProps/app.xml') },
    { name: 'docProps/core.xml', data: read('docProps/core.xml') },
    { name: 'xl/workbook.xml', data: buildWorkbook(meta) },
    { name: 'xl/_rels/workbook.xml.rels', data: read('xl/_rels/workbook.xml.rels') },
    { name: 'xl/styles.xml', data: patchStyles(read('xl/styles.xml')) },
    { name: 'xl/theme/theme1.xml', data: read('xl/theme/theme1.xml') },
    { name: 'xl/worksheets/sheet1.xml', data: buildSheet1(words, statusMap) },
    { name: 'xl/worksheets/sheet2.xml', data: buildSheet2(words.length, meta) },
    { name: 'xl/worksheets/sheet3.xml', data: buildSheet3(meta) },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: read('xl/worksheets/_rels/sheet1.xml.rels') },
    { name: 'xl/tables/table1.xml', data: buildTable(words.length) }
  ];
  fs.writeFileSync(outPath, zipArchive(files));
  return outPath;
}

module.exports = { writeWorkbook, zipArchive, crc32 };
