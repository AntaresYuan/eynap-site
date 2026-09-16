/**
 * 用 node:sqlite 模拟 D1 绑定，对 worker/index.js 做真实端到端测试。
 * 只测逻辑，不联网、不需要 Cloudflare 账号。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './index.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./migrations/0001_init.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('./migrations/0002_translation_cache.sql', import.meta.url), 'utf8'));

// 最小 D1 兼容层
const D1 = {
  prepare(sql) {
    let params = [];
    const api = {
      bind(...a) { params = a; return api; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
      async run() { return db.prepare(sql).run(...params); }
    };
    return api;
  }
};

// 模拟 Workers AI：记录调用次数，用来验证缓存是否真的生效
let aiCalls = 0, nameCalls = 0, nameReply = 'Quiet Otter';
let trCalls = 0, lastPieces = [];
const AI = {
  async run(model, input) {
    aiCalls++;
    const sys = ((input.messages || [])[0] || {}).content || '';
    if (sys.includes('handle')) {          // 起名请求
      nameCalls++;
      return { response: nameReply };
    }
    // 翻译也走指令模型，返回格式与起名一致
    if (model !== '@cf/meta/llama-3.1-8b-instruct-fp8-fast')
      throw new Error('unexpected model: ' + model);
    trCalls++;
    const user = (input.messages || []).find(m => m.role === 'user');
    if (!user || !user.content) throw new Error('empty text');
    lastPieces.push(user.content);
    // 真模型不会原样返回原文。mock 里插入标记字符打断原文串，
    // 否则会被 cleanOutput 的「原文剔除」逻辑正确地清掉
    const marked = user.content.split('').join('\u200b');   // 零宽空格
    return { response: '«' + marked + '»TR' };
  }
};

const env = { DB: D1, AI, OWNER: 'yuanchenjie.antares', SALT: 'test', ALLOW_ORIGIN: '*' };

const call = (method, path, body, ip = '1.2.3.4') =>
  worker.fetch(new Request('https://x' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: body ? JSON.stringify(body) : undefined
  }), env);

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};

console.log('\n=== Worker 端到端测试（模拟 D1）===\n');

// 1 空库
let r = await call('GET', '/api/reviews');
let d = await r.json();
ok(r.status === 200 && d.reviews.length === 0 && d.downloads === 0, '空库返回 0 条 / 下载 0');

// 2 正常提交
r = await call('POST', '/api/reviews',
  { author: '张三', text: '拆成原子之后好用多了', feature: 5, effect: 4, stability: 5, version: '2.0.0' });
d = await r.json();
ok(r.status === 200 && d.reviews[0].feature === 5 && d.reviews[0].effect === 4,
   '提交成功且三维评分正确', JSON.stringify(d).slice(0, 120));

// 3 留空署名 → 起花名（不再是写死的「匿名」）
r = await call('POST', '/api/reviews',
  { author: '   ', text: '匿名试一条', feature: 3, effect: 3, stability: 3 }, '9.9.9.9');
d = await r.json();
ok(/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(d.reviews[0].author),
   '留空署名生成英文花名', d.reviews[0].author);

// 4 作者标签
r = await call('POST', '/api/reviews',
  { author: 'yuanchenjie.antares', text: '作者本人留一条', feature: 5, effect: 5, stability: 5 }, '8.8.8.8');
d = await r.json();
ok(d.reviews[0].owner === true, '作者名匹配时打上 owner 标记');

// 5 空内容
r = await call('POST', '/api/reviews', { text: '   ', feature: 5, effect: 5, stability: 5 }, '7.7.7.7');
ok(r.status === 400, '空内容被拒（400）');

// 6 评分越界
r = await call('POST', '/api/reviews', { text: '越界评分', feature: 9, effect: 5, stability: 5 }, '7.7.7.8');
ok(r.status === 400, '评分越界被拒（400）');

// 7 评分缺失
r = await call('POST', '/api/reviews', { text: '没打分', feature: 5 }, '7.7.7.9');
ok(r.status === 400, '评分缺失被拒（400）');

// 8 重复内容
r = await call('POST', '/api/reviews',
  { author: '李四', text: '拆成原子之后好用多了', feature: 4, effect: 4, stability: 4 }, '6.6.6.6');
ok(r.status === 409, '重复内容被拒（409）');

// 9 链接过多
r = await call('POST', '/api/reviews',
  { text: 'https://a.com https://b.com https://c.com', feature: 5, effect: 5, stability: 5 }, '5.5.5.5');
ok(r.status === 400, '链接过多被拒（400）');

// 10 超长
r = await call('POST', '/api/reviews',
  { text: 'x'.repeat(1001), feature: 5, effect: 5, stability: 5 }, '4.4.4.4');
ok(r.status === 400, '超长内容被拒（400）');

// 11 限流：同一 IP 连发
const ip = '3.3.3.3';
let codes = [];
for (let i = 1; i <= 4; i++) {
  const rr = await call('POST', '/api/reviews',
    { text: '限流测试第' + i + '条', feature: 4, effect: 4, stability: 4 }, ip);
  codes.push(rr.status);
}
ok(codes.slice(0, 3).every(c => c === 200) && codes[3] === 429,
   '同一 IP 第 4 条触发限流（429）', '实际: ' + codes.join(','));

// 12 IP 不落库明文
const raw = db.prepare('SELECT ip_hash FROM reviews LIMIT 1').get();
ok(raw.ip_hash && raw.ip_hash.length === 64 && !raw.ip_hash.includes('.'),
   'IP 以散列存储，无明文');

// 13 下载计数
await call('POST', '/api/download');
await call('POST', '/api/download');
r = await call('GET', '/api/reviews');
d = await r.json();
ok(d.downloads === 2, '下载计数累加正确', '实际: ' + d.downloads);

// 14 CORS
r = await call('OPTIONS', '/api/reviews');
ok(r.headers.get('Access-Control-Allow-Origin') === '*', 'CORS 预检返回正确头');

// 15 倒序
r = await call('GET', '/api/reviews');
d = await r.json();
ok(d.reviews[0].text.includes('限流测试第3条'), '最新的排最前');

// 16 date 字段格式
ok(/^\d{4}-\d{2}-\d{2}$/.test(d.reviews[0].date), 'date 字段为 YYYY-MM-DD');

// 17 未知路由
r = await call('GET', '/nope');
ok(r.status === 404, '未知路由返回 404');

// ---- 翻译 ----
console.log('\n翻译：');

// 准备两条不同语种的评价
await call('POST', '/api/reviews',
  { author:'zhuser', text:'这个技能拆分得很清楚，单点需求不用跑整条流水线。',
    feature:5, effect:5, stability:4 }, '9.9.9.1');
await call('POST', '/api/reviews',
  { author:'enuser', text:'The orchestrator routing is clean and easy to follow.',
    feature:4, effect:4, stability:5 }, '9.9.9.2');

r = await call('GET', '/api/reviews');
d = await r.json();
const zhRow = d.reviews.find(x => x.author === 'zhuser');
const enRow = d.reviews.find(x => x.author === 'enuser');

// 18 中译英
aiCalls = 0;
r = await call('POST', '/api/translate', { id: zhRow.id, target: 'en' });
d = await r.json();
const strip = t => String(t).replace(/\u200b/g, '');
ok(r.status === 200 && strip(d.text).includes('技能拆分得很清楚'),
   '中文评价能译成英文', strip(d.text).slice(0,60));

// 19 语种识别方向正确
ok(aiCalls === 1, '首次翻译调用了一次模型', '实际 ' + aiCalls);

// 20 缓存生效
aiCalls = 0;
r = await call('POST', '/api/translate', { id: zhRow.id, target: 'en' });
d = await r.json();
ok(d.cached === true && aiCalls === 0, '第二次读缓存，不再调模型', 'aiCalls=' + aiCalls);

// 21 英译中
r = await call('POST', '/api/translate', { id: enRow.id, target: 'zh' });
d = await r.json();
ok(strip(d.text).includes('routing is clean'), '英文评价能译成中文', strip(d.text).slice(0,60));

// 22 原文即目标语言时不调模型
aiCalls = 0;
r = await call('POST', '/api/translate', { id: zhRow.id, target: 'zh' });
d = await r.json();
ok(aiCalls === 0 && d.text === zhRow.text, '目标语言与原文一致时直接回原文，不耗额度');

// 23 不存在的 id
r = await call('POST', '/api/translate', { id: 99999, target: 'en' });
ok(r.status === 404, '不存在的评价返回 404');

// 24 缺 id
r = await call('POST', '/api/translate', { target: 'en' });
ok(r.status === 400, '缺少 id 返回 400');

// 25 不接受任意文本（防止被当免费翻译 API）
r = await call('POST', '/api/translate', { text: 'translate me please', target: 'zh' });
ok(r.status === 400, '只认 id、不认任意文本');

// 26 target 非法值归一到 en
r = await call('POST', '/api/translate', { id: zhRow.id, target: 'ja' });
d = await r.json();
ok(d.target === 'en', '非法 target 归一为 en');

// 27 模型抛错时返回 503，且不写脏数据
await call('POST', '/api/reviews',
  { author:'zhuser2', text:'再来一条中文评价，用来测模型失败的情况。',
    feature:3, effect:3, stability:3 }, '9.9.9.3');
r = await call('GET', '/api/reviews');
d = await r.json();
const freshZh = d.reviews.find(x => x.author === 'zhuser2');

const brokenEnv = { ...env, AI: { async run(){ throw new Error('boom'); } } };
r = await worker.fetch(new Request('https://x/api/translate', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ id: freshZh.id, target: 'en' })
}), brokenEnv);
ok(r.status === 503, '模型失败返回 503 而不是崩溃', '实际 ' + r.status);

// 28 失败后没有写入半成品译文，重试仍能正常翻译
r = await call('POST', '/api/translate', { id: freshZh.id, target: 'en' });
d = await r.json();
ok(r.status === 200 && strip(d.text).includes('再来一条中文评价') && !d.cached,
   '失败后未写脏数据，重试可正常翻译', strip(d.text).slice(0,60));

// ---- 匿名花名 ----
console.log('\n花名：');

// 29 留空名字时调用模型起名
nameReply = 'Quiet Otter'; nameCalls = 0;
r = await call('POST', '/api/reviews',
  { text:'挺好用的，省了不少来回。', feature:4, effect:4, stability:4 }, '7.7.7.1');
d = await r.json();
let newest = d.reviews[0];
ok(newest.author === 'Quiet Otter' && nameCalls === 1,
   '留空时用 AI 起花名', newest.author);

// 30 不再出现写死的「匿名」
ok(!d.reviews.some(x => x.author === '匿名'), '库里没有写死的「匿名」');

// 31 填了名字就不调模型
nameCalls = 0;
r = await call('POST', '/api/reviews',
  { author:'realname', text:'填了名字的一条反馈内容。', feature:4, effect:4, stability:4 }, '7.7.7.2');
d = await r.json();
ok(d.reviews[0].author === 'realname' && nameCalls === 0,
   '填了名字就不起花名，也不调模型');

// 32 模型返回带引号和句号 → 清洗
nameReply = '"Swift Heron."';
r = await call('POST', '/api/reviews',
  { text:'第三条反馈，测清洗逻辑。', feature:3, effect:3, stability:3 }, '7.7.7.3');
d = await r.json();
ok(d.reviews[0].author === 'Swift Heron', '引号与句号被清掉', d.reviews[0].author);

// 33 模型跑题（整句话）→ 回落词表
nameReply = 'Sure! Here is a handle you might like for this user.';
r = await call('POST', '/api/reviews',
  { text:'第四条反馈，测跑题回落。', feature:3, effect:3, stability:3 }, '7.7.7.4');
d = await r.json();
ok(/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(d.reviews[0].author),
   '模型跑题时回落到词表', d.reviews[0].author);

// 34 模型抛错 → 仍有名字，不落「匿名」，不影响提交
const noAiEnv = { ...env, AI: { async run(){ throw new Error('down'); } } };
r = await worker.fetch(new Request('https://x/api/reviews', {
  method:'POST',
  headers:{'Content-Type':'application/json','CF-Connecting-IP':'7.7.7.5'},
  body: JSON.stringify({ text:'第五条，模型挂了也要能提交。', feature:3, effect:3, stability:3 })
}), noAiEnv);
d = await r.json();
ok(r.status === 200 && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(d.reviews[0].author),
   '模型不可用时仍能提交且有花名', d.reviews[0].author);

// 35 含数字或符号的返回被拒
nameReply = 'Agent 007';
r = await call('POST', '/api/reviews',
  { text:'第六条，测数字过滤。', feature:3, effect:3, stability:3 }, '7.7.7.6');
d = await r.json();
ok(!/\d/.test(d.reviews[0].author), '带数字的返回被拒并回落', d.reviews[0].author);

// ---- 整段翻译 ----
console.log('\n翻译：');

// 36 多句内容一次调用译完，不再拆句
await call('POST', '/api/reviews',
  { author:'multi', text:'The skill split is clean. I can call pm-prd alone. No extra glue needed.',
    feature:5, effect:5, stability:5 }, '6.6.6.1');
r = await call('GET', '/api/reviews'); d = await r.json();
const multi = d.reviews.find(x => x.author === 'multi');

trCalls = 0; lastPieces = [];
r = await call('POST', '/api/translate', { id: multi.id, target: 'zh' });
d = await r.json();
ok(trCalls === 1, '整段一次调用，不再逐句', '实际 ' + trCalls);

// 37 整段内容都进了模型，没有被提前切掉
ok(lastPieces[0] && lastPieces[0].includes('No extra glue needed'),
   '完整原文传给模型', String(lastPieces[0]).slice(0, 60));

// 38 译文里每句都在
const allIn = ['The skill split is clean','I can call pm-prd alone','No extra glue needed']
  .every(sent => strip(d.text).includes(sent));
ok(allIn, '译文包含全部句子', d.text.slice(0, 80));

// 39 单句同样只调一次
await call('POST', '/api/reviews',
  { author:'single', text:'Just one sentence here', feature:4, effect:4, stability:4 }, '6.6.6.3');
r = await call('GET', '/api/reviews'); d = await r.json();
const one = d.reviews.find(x => x.author === 'single');
trCalls = 0;
await call('POST', '/api/translate', { id: one.id, target: 'zh' });
ok(trCalls === 1, '单句也只调一次', '实际 ' + trCalls);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
