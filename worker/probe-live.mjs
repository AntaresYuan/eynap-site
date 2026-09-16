/**
 * 线上真实模型测试：造一批覆盖各种写法的评价，逐条翻译并检查结果。
 * 会真实消耗 neurons，只在需要验证模型表现时跑。
 */
const API = 'https://eynap-api.chenjy4.workers.dev';

// [内容, 目标语言, 必须出现在译文里的片段（原文保留项）, 说明]
const CASES = [
  ['The skill split is clean. I can call pm-prd alone without running the whole pipeline.',
   'zh', ['pm-prd'], '两句英文 + 术语'],
  ['拆分很清楚。单点需求不用跑全流程；上手也快。',
   'en', [], '三句中文，含分号'],
  ['Read SKILL.md first. It explains how pm-entity and pm-design fit together.',
   'zh', ['SKILL.md', 'pm-entity', 'pm-design'], '含点号文件名 + 两个术语'],
  ['One sentence only',
   'zh', [], '单句无标点'],
  ['Works on v2.0.0 fine. No issues so far.',
   'zh', [], '版本号不该被拆'],
  ['我用 pm-research 做了竞品调研，结论直接喂给 pm-value，省了一轮返工。',
   'en', ['pm-research', 'pm-value'], '中文长句 + 两个术语'],
  ['Great! Really useful. Would recommend.',
   'zh', [], '三个短句'],
  ['The orchestrator decides the stage. Then it routes to one skill.',
   'zh', [], 'orchestrator 需译后修正'],
];

const j = (o) => JSON.stringify(o);
let pass = 0, fail = 0, ids = [];

/* 样本由 seed-probe.sh 直接写库，这里只负责翻译与核对。
   走 API 提交会撞上反垃圾限流——那是给真实用户的保护，不该为自测放宽。 */

async function translate(id, target) {
  const r = await fetch(API + '/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: j({ id, target })
  });
  return r.json();
}

// 句数统计要排除小数点、版本号里的点，且中英标点都算——
// 否则 v2.0.0 会被数成三句，中文译文用中文标点会被数成零句
const sentCount = (t) => {
  const cleaned = String(t).replace(/\d\.\d/g, '00');   // 3.5 / v2.0.0
  return (cleaned.match(/[。！？；]|[.!?](?=\s|$)/g) || []).length;
};

console.log('线上模型实测\n');

// 一次性取回全部评价，避免逐条提交触发限流
const existing = (await (await fetch(API + '/api/reviews')).json()).reviews || [];
const byText = new Map(existing.map(r => [r.text, r.id]));

for (const [text, target, keep, label] of CASES) {
  const id = byText.get(text);
  if (!id) { console.log(`  ✗ ${label}：拿不到 id`); fail++; continue; }
  ids.push(id);

  const d = await translate(id, target);
  if (!d.text) { console.log(`  ✗ ${label}：${j(d)}`); fail++; continue; }

  const srcN = sentCount(text);
  const outN = sentCount(d.text);
  const missing = keep.filter(k => !d.text.includes(k));
  // 句数允许差 1（标点转换有出入），但不能腰斩
  const sentOk = srcN === 0 || outN >= Math.max(1, srcN - 1);
  const good = missing.length === 0 && sentOk && d.text.length > 2;

  if (good) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    console.log(`  ✗ ${label}`);
    if (missing.length) console.log(`      术语丢失: ${missing.join(', ')}`);
    if (!sentOk) console.log(`      句数 ${srcN} → ${outN}`);
  }
  console.log(`      ${d.text}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log('探针 id: ' + ids.join(','));
