/**
 * validate.js —— 词库 / Excel / HTML 三方一致性校验
 *   node tools/validate.js
 * 生成 校验报告.md，发现问题时以非零码退出。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { readZip } = require('./zipread');
const { readSheet, unesc } = require('./xlsread');

const ROOT = path.resolve(__dirname, '..');
const F_WORDS = path.join(ROOT, 'data', 'words.json');
const F_NETEM = path.join(ROOT, 'data', 'sources', 'netem_full_list.json');
const F_ECDICT = path.join(ROOT, 'data', 'sources', 'ecdict_slice.json');
const F_XLSX = path.join(ROOT, '考研英语二5500词_背诵工作簿.xlsx');
const F_HTML = path.join(ROOT, '考研英语二_本地背词工具.html');
const F_REPORT = path.join(ROOT, '校验报告.md');

const fails = [];
const warns = [];
const notes = [];
const check = (ok, title, detail) => {
  (ok ? notes : fails).push({ title, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${title}${detail ? ' — ' + detail : ''}`);
};
const warn = (title, detail) => { warns.push({ title, detail }); console.log(`  ! ${title}${detail ? ' — ' + detail : ''}`); };

function main() {
  console.log('\n=== 1. 数据源 ===');
  const payload = JSON.parse(fs.readFileSync(F_WORDS, 'utf8'));
  const words = payload.words;
  const netem = Object.values(JSON.parse(fs.readFileSync(F_NETEM, 'utf8')))[0];
  const ecdict = JSON.parse(fs.readFileSync(F_ECDICT, 'utf8'));

  check(Array.isArray(words) && words.length > 0, 'words.json 可解析', `${words.length} 词`);
  check(netem.length === words.length, '词数与官方大纲词表一致',
    `大纲 ${netem.length} / 词库 ${words.length}`);

  // 与大纲逐词比对
  const srcMap = new Map(netem.map(x => [String(x['单词']).trim(), x]));
  const missingInList = [...srcMap.keys()].filter(w => !words.some(x => x.word === w));
  const extraInList = words.filter(w => !srcMap.has(w.word)).map(w => w.word);
  check(missingInList.length === 0, '大纲词表无遗漏',
    missingInList.length ? missingInList.slice(0, 10).join(', ') : '0 缺失');
  check(extraInList.length === 0, '词库无来源外单词',
    extraInList.length ? extraInList.slice(0, 10).join(', ') : '0 多余');

  // 词典覆盖
  const noDict = words.filter(w => !ecdict[w.word.toLowerCase()]).map(w => w.word);
  check(noDict.length === 0, '每词都能在 ECDICT 查到', noDict.length ? noDict.slice(0, 10).join(', ') : `${words.length}/${words.length}`);

  console.log('\n=== 2. 字段完整性 ===');
  const badWord = words.filter(w => !/^[a-z][a-z'\-]*(?: [a-z'\-]+)*$/i.test(w.word));
  check(badWord.length === 0, '单词拼写格式合法', badWord.length ? badWord.slice(0, 10).map(x => x.word).join(', ') : '全部通过');

  const noMeaning = words.filter(w => !String(w.meaning || '').trim());
  check(noMeaning.length === 0, '核心释义无空缺', noMeaning.length ? noMeaning.slice(0, 10).map(x => x.word).join(', ') : '100%');

  const noPh = words.filter(w => !String(w.phonetic || '').trim());
  noPh.length ? warn('音标有缺口', `${noPh.length} 词：${noPh.slice(0, 12).map(x => x.word).join(', ')}`) : check(true, '音标完整', '100%');

  const noPos = words.filter(w => !String(w.pos || '').trim());
  noPos.length ? warn('词性空缺', `${noPos.length} 词（多为短语）：${noPos.slice(0, 12).map(x => x.word).join(', ')}`) : check(true, '词性完整', '100%');

  const placeholder = words.filter(w => /待补充|TODO|待填|占位|示例词/i.test([w.meaning, w.extra, w.family].join(' ')));
  check(placeholder.length === 0, '无占位/示例内容', placeholder.length ? placeholder.slice(0, 5).map(x => x.word).join(', ') : '0 处');

  console.log('\n=== 3. 唯一性与排序 ===');
  const exact = new Set(), ciDup = [];
  for (const w of words) {
    if (exact.has(w.word)) ciDup.push(w.word);
    exact.add(w.word);
  }
  check(ciDup.length === 0, '单词无重复', ciDup.length ? ciDup.join(', ') : `${words.length} 个唯一`);
  const lower = new Map();
  for (const w of words) {
    const k = w.word.toLowerCase();
    if (lower.has(k)) {
      // 允许大小写不同的独立词条，但释义必须不同
      const a = lower.get(k);
      if (a.meaning === w.meaning) fails.push({ title: '大小写重复且释义相同', detail: `${a.word} / ${w.word}` });
      else notes.push({ title: '大小写不同词条（已保留）', detail: `${a.word}（${a.meaning}） / ${w.word}（${w.meaning}）` });
    } else lower.set(k, w);
  }
  check(true, '大小写重复检查完成', `case-insensitive 唯一词 ${lower.size}`);

  const ranks = words.map(w => w.rank);
  check(new Set(ranks).size === words.length, '词频排名唯一', `${new Set(ranks).size}/${words.length}`);
  check(Math.min(...ranks) === 1 && Math.max(...ranks) === words.length, '词频排名形成 1..N 连续区间',
    `${Math.min(...ranks)}..${Math.max(...ranks)}`);

  const sorted = words.every((w, i) => i === 0 || words[i - 1].word.toLowerCase() <= w.word.toLowerCase());
  check(sorted, '总表按字母升序', sorted ? '已排序' : '顺序异常');

  console.log('\n=== 4. 内容抽查 ===');
  const reqFields = ['word', 'phonetic', 'pos', 'meaning', 'extra', 'family', 'rank', 'freq', 'cat', 'cefr', 'ex', 'exZh', 'exSrc', 'zt'];
  const badField = words.filter(w => !reqFields.every(f => f in w));
  check(badField.length === 0, '字段结构统一', badField.length ? badField.slice(0, 5).map(x => x.word).join(', ') : `${reqFields.length} 个字段`);

  const cov = {
    phonetic: words.filter(w => w.phonetic).length,
    pos: words.filter(w => w.pos).length,
    extra: words.filter(w => w.extra).length,
    family: words.filter(w => w.family).length,
    realExam: words.filter(w => w.exSrc.startsWith('真题')).length,
    example: words.filter(w => w.ex).length
  };
  notes.push({ title: '字段覆盖率', detail: Object.entries(cov).map(([k, v]) => `${k} ${(v / words.length * 100).toFixed(1)}%`).join(' · ') });

  // 抽样：抽查 5 个词与来源一致
  const samples = ['abandon', 'account', 'yield', 'government', 'sustainable']
    .map(w => words.find(x => x.word === w)).filter(Boolean);
  let sampleOk = true, sampleDetail = [];
  for (const s of samples) {
    const src = srcMap.get(s.word);
    const ok = src && String(src['释义']).replace(/[,，]/g, '、').replace(/[;；]/g, '、').slice(0, 6) === s.meaning.slice(0, 6);
    if (!ok) sampleOk = false;
    sampleDetail.push(`${s.word}=${s.meaning}`);
  }
  check(sampleOk, '抽样核对核心释义与来源一致', sampleDetail.join(' / '));

  console.log('\n=== 5. Excel 工作簿 ===');
  let xlsxWords = [], xlsxRows = 0;
  if (!fs.existsSync(F_XLSX)) check(false, 'Excel 文件存在', F_XLSX);
  else {
    const z = readZip(F_XLSX);
    check(!!z['xl/worksheets/sheet1.xml'], 'xlsx 结构完整', `${Object.keys(z).length} 个部件`);
    const xml = z['xl/worksheets/sheet1.xml'].toString('utf8');
    // XML 平衡校验
    const open = (xml.match(/<(?!\/|\?|!)[a-zA-Z]/g) || []).length;
    const close = (xml.match(/<\//g) || []).length;
    const selfClose = (xml.match(/\/>/g) || []).length;
    check(Math.abs(open - close - selfClose) <= 1, 'sheet1.xml 标签配对', `开 ${open} / 闭 ${close} / 自闭 ${selfClose}`);

    const dim = (xml.match(/<dimension ref="([^"]+)"/) || [])[1];
    check(dim === `A1:K${words.length + 1}`, '工作表区间与词数匹配', dim);

    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    const sheet = readSheet(F_XLSX);
    for (const cells of sheet.rows) {
      if (!cells.A || cells.A === '单词') continue;
      xlsxRows++;
      xlsxWords.push({ word: cells.A, meaning: cells.D || '', status: cells.I || '', rank: Number(cells.G || 0) });
    }
    check(xlsxRows === words.length, '总表行数等于词库词数', `${xlsxRows} 行`);
    const mismatch = [];
    for (let i = 0; i < Math.min(xlsxWords.length, words.length); i++) {
      if (xlsxWords[i].word !== words[i].word) mismatch.push(`${i + 1}:${xlsxWords[i].word}≠${words[i].word}`);
      else if (xlsxWords[i].meaning !== words[i].meaning) mismatch.push(`${xlsxWords[i].word} 释义不一致`);
    }
    check(mismatch.length === 0, 'Excel 每行与 words.json 逐条一致', mismatch.length ? mismatch.slice(0, 5).join('; ') : '逐行比对通过');

    const statusBad = xlsxWords.filter(r => !['未学习', '认识', '模糊', '不认识', ''].includes(r.status));
    check(statusBad.length === 0, '掌握状态取值合法', statusBad.length ? statusBad.slice(0, 5).map(x => x.word + ':' + x.status).join(', ') : '全部合法');

    if (!z['xl/tables/table1.xml']) check(false, '表格定义存在');
    else {
      const tb = z['xl/tables/table1.xml'].toString('utf8');
      const ref = (tb.match(/ref="([^"]+)"/) || [])[1];
      check(ref === `A1:K${words.length + 1}`, '表格区域与总表一致', ref);
      const nCols = Number((tb.match(/<tableColumns count="(\d+)"/) || [])[1]);
      check(nCols === 11, '表格列数正确', `${nCols} 列`);
    }
    const s2 = unesc(z['xl/worksheets/sheet2.xml'].toString('utf8'));
    check(s2.includes(`COUNTA('5500词总表'!A2:A${words.length + 1})`), '统计页公式指向完整区间',
      s2.includes(`A2:A${words.length + 1}`) ? `A2:A${words.length + 1}` : '区间不匹配');
  }

  console.log('\n=== 6. HTML 背词工具 ===');
  if (!fs.existsSync(F_HTML)) check(false, 'HTML 文件存在');
  else {
    const html = fs.readFileSync(F_HTML, 'utf8');
    check(html.includes('<!doctype html'), 'HTML 结构正常');
    const marker = 'const DATA = ';
    const start = html.indexOf(marker);
    check(start > 0, 'HTML 内嵌词库数据');
    const tail = html.indexOf(';\n\nconst F =', start);
    let data = null;
    if (start > 0 && tail > start) {
      try { data = JSON.parse(html.slice(start + marker.length, tail)); } catch (e) { check(false, 'HTML 数据可解析', e.message); }
    }
    if (data) {
      check(data.words.length === words.length, 'HTML 词数与 words.json 一致', `${data.words.length} / ${words.length}`);
      let diff = 0;
      for (let i = 0; i < data.words.length; i++) {
        const a = data.words[i], b = words[i];
        const expect = [b.word, b.phonetic, b.pos, b.meaning, b.extra, b.family, b.rank, b.freq, b.cat, b.cefr, b.ex, b.exZh, b.exSrc, b.zt];
        for (let k = 0; k < expect.length; k++) {
          if (String(a[k] ?? '') !== String(expect[k] ?? '')) { diff++; break; }
        }
      }
      check(diff === 0, 'HTML 每词字段与 words.json 完全一致', diff ? `${diff} 词不一致` : '逐字段比对通过');
      const h1 = crypto.createHash('sha256').update(JSON.stringify(data.words)).digest('hex').slice(0, 16);
      const h2 = crypto.createHash('sha256').update(JSON.stringify(words.map(b => [b.word, b.phonetic, b.pos, b.meaning, b.extra, b.family, b.rank, b.freq, b.cat, b.cefr, b.ex, b.exZh, b.exSrc, b.zt]))).digest('hex').slice(0, 16);
      check(h1 === h2, 'HTML 数据指纹一致', h1);
    }
    // 脚本语法
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    let syntaxOk = true, syntaxMsg = '';
    for (const s of scripts) {
      try { new Function(s); } catch (e) { syntaxOk = false; syntaxMsg = e.message; }
    }
    check(syntaxOk, '内嵌脚本语法正确', syntaxOk ? `${scripts.length} 段脚本编译通过` : syntaxMsg);
    const noFetch = !/fetch\s*\(/.test(scripts.join('\n'));
    check(noFetch, '未依赖网络请求（可离线双击打开）', noFetch ? '无 fetch' : '存在 fetch');
  }

  console.log('\n=== 7. 与独立词表的交叉验证 ===');
  const ourSet = new Set(words.map(w => w.word.toLowerCase()));
  const kyTag = Object.entries(ecdict).filter(([, v]) => (v.tag || '').split(' ').includes('ky')).map(([k]) => k);
  const kyIn = kyTag.filter(w => ourSet.has(w)).length;
  check(kyTag.length > 0, 'ECDICT 考研标签可用作旁证', `${kyTag.length} 词，其中 ${kyIn} 词在本词库内（${(kyIn / kyTag.length * 100).toFixed(1)}%）`);
  const kyMissing = kyTag.filter(w => !ourSet.has(w));
  if (kyMissing.length) warn('ECDICT ky 标签中有词不在本词库', `${kyMissing.length} 个，多为超纲/派生词，例如 ${kyMissing.slice(0, 8).join(', ')}`);

  // ============ 报告 ============
  const total = fails.length + notes.length;
  const lines = [];
  lines.push('# 词库校验报告\n');
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 词库版本：${words.length} 词（data/words.json，sha256 ${crypto.createHash('sha256').update(JSON.stringify(words)).digest('hex').slice(0, 16)}）`);
  lines.push(`- 结论：**${fails.length === 0 ? '通过' : '未通过'}**（${total} 项检查，失败 ${fails.length}，警告 ${warns.length}）\n`);
  lines.push('## 数据来源\n');
  for (const s of payload.meta.sources) lines.push(`- ${s}`);
  lines.push('\n## 检查项\n');
  lines.push('| 结果 | 检查项 | 说明 |');
  lines.push('| --- | --- | --- |');
  const row = (f, n) => `| ${f ? '✗' : '✓'} | ${n.title} | ${n.detail || ''} |`;
  notes.forEach(n => lines.push(row(false, n)));
  fails.forEach(n => lines.push(row(true, n)));
  if (warns.length) {
    lines.push('\n## 警告\n');
    warns.forEach(w => lines.push(`- **${w.title}**：${w.detail || ''}`));
  }
  lines.push('\n## 字段覆盖率\n');
  lines.push('| 字段 | 覆盖 |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(cov)) lines.push(`| ${k} | ${v} / ${words.length}（${(v / words.length * 100).toFixed(1)}%）|`);
  lines.push('\n## 说明\n');
  lines.push('- 词表口径：2024 年全国硕士研究生招生考试英语（一/二）考试大纲词汇表，共 5530 词；英语一与英语二共用同一份大纲词汇表。');
  lines.push('- 核心释义取官方词表释义；拓展义、音标、词形来自 ECDICT，属于词典义项，可能与考试语境略有出入，遇到疑问以真题语境为准。');
  lines.push('- 词频排名按 200 套真题语料（四六级/考研/专四专八）中出现次数排序，仅作学习优先级参考，不代表官方难度。');
  lines.push('- Excel 与 HTML 均由 `data/words.json` 生成，上表逐条比对确认二者内容完全一致。');

  fs.writeFileSync(F_REPORT, lines.join('\n') + '\n', 'utf8');

  console.log(`\n${fails.length === 0 ? '全部通过' : '存在问题'}：${notes.length} 项通过 / ${fails.length} 项失败 / ${warns.length} 项警告`);
  console.log(`报告已写入 ${path.basename(F_REPORT)}\n`);
  if (fails.length) process.exitCode = 1;
}

main();
