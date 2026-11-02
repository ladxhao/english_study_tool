/**
 * build.js —— 单一数据源 data/words.json → Excel + HTML + CSV
 *
 *   node tools/build.js
 *
 * 特性：
 *   · 生成的 Excel / HTML 内容完全来自同一份 words.json，不会各说各话
 *   · 覆盖 Excel 前，自动备份旧文件，并把已有的「掌握状态 / 最近复习日期 / 个人备注」带过去
 *   · 不做任何联网操作，纯本地
 */
const fs = require('fs');
const path = require('path');
const { writeWorkbook } = require('./xlsx');
const { readSheet, excelDate } = require('./xlsread');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'words.json');
const XLSX_OUT = path.join(ROOT, '考研英语二5500词_背诵工作簿.xlsx');
const HTML_OUT = path.join(ROOT, '考研英语二_本地背词工具.html');
const CSV_OUT = path.join(ROOT, '考研英语二_词库.csv');
const TPL = path.join(__dirname, 'template');
const HTML_TPL = path.join(__dirname, 'template.html');

// ---------------- 读旧工作簿的进度 ----------------
function readProgress(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  let rows;
  try { rows = readSheet(file).rows; } catch (e) { console.warn('  ! 旧工作簿读取失败，进度未迁移：' + e.message); return map; }
  for (const cells of rows) {
    const word = (cells.A || '').trim();
    if (!word || word === '单词') continue;
    const status = (cells.I || '').trim();
    const date = excelDate(cells.J);
    const note = (cells.K || '').trim();
    if (status && status !== '未学习') map[word] = { status, date, note };
    else if (note) map[word] = { status: status || '未学习', date, note };
  }
  return map;
}

// ---------------- CSV ----------------
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildCsv(words) {
  const head = ['单词', '音标', '词性', '核心释义', '熟词僻义/拓展义', '派生词/词形', '词频排名', '参考词频', '考试分类', 'CEFR', '真题次数', '例句', '例句翻译', '例句来源'];
  const lines = [head.map(csvCell).join(',')];
  for (const w of words) {
    lines.push([
      w.word, w.phonetic, w.pos, w.meaning, w.extra, w.family, w.rank, w.freq,
      w.cat, w.cefr, w.zt, w.ex, w.exZh, w.exSrc
    ].map(csvCell).join(','));
  }
  return '\ufeff' + lines.join('\r\n');
}

// ---------------- 精简 HTML 内嵌数据 ----------------
function htmlData(payload) {
  return {
    meta: payload.meta,
    words: payload.words.map(w => [w.word, w.phonetic, w.pos, w.meaning, w.extra, w.family, w.rank, w.freq, w.cat, w.cefr, w.ex, w.exZh, w.exSrc, w.zt])
  };
}

// ---------------- main ----------------
function main() {
  if (!fs.existsSync(DATA)) throw new Error('缺少 data/words.json，请先运行 node tools/build-words.js');
  const payload = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const words = payload.words;
  console.log(`词库：${words.length} 词`);

  // 备份 + 迁移进度
  const statusMap = readProgress(XLSX_OUT);
  const migrated = Object.keys(statusMap).length;
  if (fs.existsSync(XLSX_OUT)) {
    const dir = path.join(ROOT, 'data', 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bak = path.join(dir, `工作簿_${stamp}.xlsx`);
    fs.copyFileSync(XLSX_OUT, bak);
    console.log(`旧工作簿已备份：${path.relative(ROOT, bak)}`);
  }
  if (migrated) console.log(`已迁移学习进度：${migrated} 条`);

  // Excel
  const meta = {
    count: words.length,
    sourceShort: '2024 考研英语（一/二）考试大纲词汇表 5530 词'
  };
  writeWorkbook(XLSX_OUT, { words, statusMap, meta, templateDir: TPL });
  console.log(`Excel 已生成：${path.basename(XLSX_OUT)}  (${(fs.statSync(XLSX_OUT).size / 1048576).toFixed(2)} MB)`);

  // CSV
  fs.writeFileSync(CSV_OUT, buildCsv(words), 'utf8');
  console.log(`CSV 已生成：${path.basename(CSV_OUT)}`);

  // HTML
  if (fs.existsSync(HTML_TPL)) {
    const tpl = fs.readFileSync(HTML_TPL, 'utf8');
    const data = JSON.stringify(htmlData(payload));
    const html = tpl.replace('/*__WORDS_DATA__*/null', data);
    if (!html.includes(data.slice(0, 40))) throw new Error('HTML 模板缺少 __WORDS_DATA__ 占位符');
    fs.writeFileSync(HTML_OUT, html, 'utf8');
    console.log(`HTML 已生成：${path.basename(HTML_OUT)}  (${(fs.statSync(HTML_OUT).size / 1048576).toFixed(2)} MB)`);
  } else {
    console.warn('  ! 未找到 tools/template.html，跳过 HTML 生成');
  }

  console.log('完成。建议接着运行 node tools/validate.js');
}

main();
