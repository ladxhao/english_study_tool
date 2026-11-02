/**
 * build-words.js
 * 从原始来源合成单一数据源 data/words.json
 *
 * 输入：
 *   data/sources/netem_full_list.json   大纲 5530 词表（词频、释义、例句）
 *   data/sources/ecdict_slice.json      ECDICT 词典切片（音标、义项、词形）
 * 输出：
 *   data/words.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'sources');
const OUT = path.join(ROOT, 'data', 'words.json');

// ---------- 词性归一化 ----------
const POS_MAP = {
  'n.': 'n.', 'v.': 'v.', 'vt.': 'v.', 'vi.': 'v.', 'adj.': 'adj.', 'a.': 'adj.',
  'adv.': 'adv.', 'ad.': 'adv.', 'prep.': 'prep.', 'conj.': 'conj.', 'pron.': 'pron.',
  'num.': 'num.', 'art.': 'art.', 'int.': 'int.', 'aux.': 'aux.', 'abbr.': 'abbr.',
  'pl.': 'n.', 'vbl.': 'v.', 'imper.': 'v.', 'refl.': 'pron.'
};
const POS_ORDER = ['n.', 'v.', 'adj.', 'adv.', 'prep.', 'pron.', 'conj.', 'num.', 'art.', 'int.', 'aux.', 'abbr.'];

// ---------- 音标归一化 ----------
function cleanPhonetic(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  s = s
    .replace(/\u04d9/g, 'ə')   // ә (西里尔) -> ə
    .replace(/\u0454/g, 'ɛ')   // є -> ɛ
    .replace(/\u02b2/g, 'j')
    .replace(/[\^\\;]/g, '')
    .replace(/'/g, 'ˈ')
    .replace(/,/g, 'ˌ')
    .replace(/:/g, 'ː')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return '/' + s.replace(/^\/+|\/+$/g, '') + '/';
}

// ---------- 义项解析 ----------
function parseSenses(translation) {
  const out = [];
  if (!translation) return out;
  for (const line of String(translation).split(/\\n|\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('[')) continue;
    const m = t.match(/^([a-z]{1,5}\.)\s*(.*)$/);
    const rawPos = m ? m[1] : '';
    const body = m ? m[2] : t;
    const pos = POS_MAP[rawPos] || (rawPos ? rawPos : '');
    for (const item of body.split(/[,，;；]/)) {
      const s = item.replace(/\.{3}/g, '…').replace(/\s+/g, ' ').trim();
      if (s) out.push({ pos, text: s });
    }
  }
  return out;
}

const norm = s => String(s || '').replace(/[\s，。、；：,.;:()（）“”"'\u3000…·-]/g, '').toLowerCase();
const overlap = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
};

// ---------- 词形解析 ----------
const EX_LABEL = { p: '过去式', d: '过去分词', i: '现在分词', 3: '第三人称单数', s: '复数', r: '比较级', t: '最高级' };
function parseForms(exchange) {
  const out = [];
  if (!exchange) return out;
  for (const part of String(exchange).split('/')) {
    const m = part.match(/^([a-z0-9]+):(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (!val) continue;
    if (!EX_LABEL[key] || key === 't') continue;
    // 过滤明显不是词形变化的（如 abbr）
    if (/[^a-zA-Z'\- ]/.test(val)) continue;
    out.push({ key, val });
  }
  const seen = new Set();
  const uniq = [];
  for (const f of out) {
    const k = f.val.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(f);
  }
  return uniq;
}

function main() {
  const netemPath = path.join(SRC, 'netem_full_list.json');
  const ecdictPath = path.join(SRC, 'ecdict_slice.json');
  if (!fs.existsSync(netemPath)) throw new Error('缺少 data/sources/netem_full_list.json');
  if (!fs.existsSync(ecdictPath)) throw new Error('缺少 data/sources/ecdict_slice.json');

  const netemRaw = JSON.parse(fs.readFileSync(netemPath, 'utf8'));
  const list = Array.isArray(netemRaw) ? netemRaw : Object.values(netemRaw)[0];
  const ecdict = JSON.parse(fs.readFileSync(ecdictPath, 'utf8'));

  console.log(`大纲词表: ${list.length} 词 | ECDICT 切片: ${Object.keys(ecdict).length} 词`);

  // 词表内互相引用的派生词
  const lemmaIndex = new Map();
  for (const [w, e] of Object.entries(ecdict)) {
    const m = String(e.ex || '').match(/(?:^|\/)0:([^/]+)/);
    if (!m) continue;
    const base = m[1].toLowerCase();
    if (!lemmaIndex.has(base)) lemmaIndex.set(base, []);
    lemmaIndex.get(base).push(w);
  }
  const listSet = new Set(list.map(x => String(x['单词']).toLowerCase()));

  const words = [];
  const missingDict = [];

  for (const it of list) {
    const word = String(it['单词']).trim();
    const key = word.toLowerCase();
    const e = ecdict[key];

    // 核心释义：官方词表释义（人工校对过，考试口径），统一分隔符
    let meaning = String(it['释义'] || '').trim()
      .replace(/[,，]/g, '、')
      .replace(/[;；]/g, '、')
      .replace(/、+/g, '、')
      .replace(/^、|、$/g, '')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\s*、\s*/g, '、');
    // 部分释义形如 "v. 使..."，把词性前缀剥出来
    const pm = meaning.match(/^([a-z]{1,5}\.)\s*(.+)$/);
    let headPos = '';
    if (pm) { headPos = POS_MAP[pm[1]] || pm[1]; meaning = pm[2]; }

    const senses = e ? parseSenses(e.tr) : [];
    const posSet = new Set();
    if (headPos) posSet.add(headPos);
    senses.forEach(s => { if (s.pos) posSet.add(s.pos); });
    // 词性顺序按词典义项出现先后（先出现的通常是主要词性），不强行排序
    const posArr = [...posSet].filter(p => POS_ORDER.includes(p));
    const pos = posArr.join('/');

    // 熟词僻义/拓展义：ECDICT 中未被核心释义覆盖的义项，保留 4 条
    const kept = [];
    const used = new Set();
    for (const s of senses) {
      if (kept.length >= 4) break;
      if (overlap(s.text, meaning)) continue;
      const nk = norm(s.text);
      if (!nk || nk.length < 2 || used.has(nk)) continue;
      used.add(nk);
      kept.push({ pos: s.pos || '', text: s.text });
    }
    const groups = [];
    for (const k of kept) {
      const last = groups[groups.length - 1];
      if (last && last.pos === k.pos) last.items.push(k.text);
      else groups.push({ pos: k.pos, items: [k.text] });
    }
    const extra = groups
      .map(g => (g.pos ? g.pos + ' ' : '') + g.items.join('、'))
      .join('；');

    // 派生词/词形
    const forms = e ? parseForms(e.ex) : [];
    const famSet = new Set();
    const famList = [];
    for (const f of forms) {
      if (f.val.toLowerCase() === key) continue;
      if (famSet.has(f.val.toLowerCase())) continue;
      famSet.add(f.val.toLowerCase());
      famList.push(f.val);
    }
    for (const w of (lemmaIndex.get(key) || [])) {
      if (w === key || !listSet.has(w)) continue;
      if (famSet.has(w)) continue;
      famSet.add(w);
      famList.push(w);
    }
    const family = famList.slice(0, 5).join(', ');

    const freq = Number(it['词频'] || 0);
    const rank = Number(it['序号'] || 0);

    if (!e) missingDict.push(word);

    words.push({
      word,
      phonetic: e ? cleanPhonetic(e.ph) : '',
      pos,
      meaning,
      extra,
      family,
      rank,
      freq,
      cat: String(it['分类名称'] || '').replace(/\s*\(.*\)\s*/g, ''),
      cefr: it['CEFR等级'] || '',
      zt: Number(it['真题次数'] || 0),
      ex: String(it['例句'] || '').trim(),
      exZh: String(it['例句翻译'] || '').trim(),
      exSrc: String(it['例句来源'] || '').trim()
    });
  }

  // 按字母排序，便于查词
  words.sort((a, b) => a.word.toLowerCase().localeCompare(b.word.toLowerCase(), 'en') || a.word.localeCompare(b.word, 'en'));

  const withExtra = words.filter(w => w.extra).length;
  const withFam = words.filter(w => w.family).length;
  const withPh = words.filter(w => w.phonetic).length;
  const withPos = words.filter(w => w.pos).length;
  const ztCount = words.filter(w => w.exSrc.startsWith('真题')).length;

  const payload = {
    meta: {
      name: '考研英语二 5500 词库',
      count: words.length,
      builtAt: new Date().toISOString().slice(0, 10),
      sources: [
        'exam-data/NETEMVocabulary · netem_full_list.json（2024 考研英语大纲词汇表 5530 词 + 200 套真题词频 + 释义 + 例句，CC BY-NC-SA 4.0）',
        'skywind3000/ECDICT · ecdict.csv（音标、义项、词形变化；MIT）'
      ],
      coverage: { phonetic: withPh, pos: withPos, extra: withExtra, family: withFam, realExamExample: ztCount }
    },
    words
  };

  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');
  const hash = crypto.createHash('sha256').update(JSON.stringify(words)).digest('hex').slice(0, 16);
  console.log(`已生成 data/words.json：${words.length} 词`);
  console.log(`  音标 ${withPh} | 词性 ${withPos} | 拓展义 ${withExtra} | 词形 ${withFam} | 真题例句 ${ztCount}`);
  console.log(`  词典缺失 ${missingDict.length}${missingDict.length ? '：' + missingDict.slice(0, 10).join(',') : ''}`);
  console.log(`  sha256(words)=${hash}`);
}

main();
