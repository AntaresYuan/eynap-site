/**
 * 用 node:sqlite 模拟 D1 绑定，对 worker/index.js 做真实端到端测试。
 * 只测逻辑，不联网、不需要 Cloudflare 账号。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './index.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./migrations/0001_init.sql', import.meta.url), 'utf8'));

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

const env = { DB: D1, OWNER: 'yuanchenjie.antares', SALT: 'test', ALLOW_ORIGIN: '*' };

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

// 3 匿名
r = await call('POST', '/api/reviews',
  { author: '   ', text: '匿名试一条', feature: 3, effect: 3, stability: 3 }, '9.9.9.9');
d = await r.json();
ok(d.reviews[0].author === '匿名', '留空署名回退为「匿名」');

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
