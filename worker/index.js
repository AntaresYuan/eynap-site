/**
 * Eynap 评价服务 — Cloudflare Workers + D1
 *
 * 接口与本地 server.mjs 完全一致，页面只需换 API 地址：
 *   GET  /api/reviews   → { reviews: [...], downloads: n }
 *   POST /api/reviews   → 写入一条，返回同上
 *   POST /api/download  → 下载计数 +1
 *
 * 反垃圾（不引入第三方服务，全部本地判定）：
 *   1. 同一 IP 10 分钟内最多 3 条
 *   2. 内容长度与链接数量上限
 *   3. 重复内容拒收
 *   IP 只存单向散列，不存原始地址。
 */

const MAX_TEXT = 1000;
const MAX_AUTHOR = 40;
const WINDOW_MIN = 10;      // 限流窗口（分钟）
const WINDOW_MAX = 3;       // 窗口内最多提交数
const MAX_LINKS = 2;        // 正文最多允许的链接数

const json = (obj, status = 200, origin = '*') =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
      'Cache-Control': 'no-store'
    }
  });

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const clampRate = v =>
  Number.isFinite(+v) && +v >= 1 && +v <= 5 ? Math.round(+v) : null;

async function listReviews(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, author, text, feature, effect, stability, version,
            substr(created_at, 1, 10) AS date
       FROM reviews
      WHERE visible = 1
      ORDER BY id DESC
      LIMIT 200`
  ).all();

  const row = await env.DB.prepare(
    `SELECT value FROM counters WHERE key = 'downloads'`
  ).first();

  return {
    reviews: (results || []).map(r => ({ ...r, owner: r.author === env.OWNER })),
    downloads: row?.value ?? 0
  };
}

/* 判断文本主体语种：中日韩统一按中文处理（m2m100 的 zh 覆盖汉字） */
function guessLang(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk === 0) return 'en';
  // 汉字占比超过拉丁字母的 1/4 就算中文为主
  return cjk * 4 > latin ? 'zh' : 'en';
}

/* 本项目的专有名词。m2m100 是通用模型，会把 orchestrator 译成「管弦乐队」，
   技能名更是必然被拆开。翻译前替换成占位符，翻完还原。 */
// 两类处理，分开做：
// 1) 占位保护——只给带连字符的技能名，它们必被模型拆开。数量少，不影响句子完整度。
const KEEP_TERMS = [
  'pm-research','pm-value','pm-prd','pm-entity','pm-design','pm-orchestrator',
  'SKILL.md','Eynap','eynap'
];

// 2) 译后修正——通用词翻译出来语义跑偏（orchestrator→管弦乐队），
//    但占位保护会让 m2m100 丢句子，所以放它正常翻，翻完再纠回来。
const FIX_AFTER = {
  zh: [
    [/管弦乐队|管弦乐团|交响乐团|乐团指挥|协调者|指挥家|乐队/g, '编排者'],
    [/舞台阶段|决定舞台/g, '决定阶段'],
    [/路线到|走向一个|导向到/g, '路由到'],
    [/技能清洁分离/g, '技能职责分离'],
    [/易于延伸/g, '易于扩展'],
    [/拨打|打电话给|呼叫/g, '调用'],          // call 在这里是调用，不是打电话
    [/管道/g, '流水线'],                      // pipeline
    [/技能分裂|技能分割/g, '技能拆分'],
    [/干净的|清洁的/g, '清晰的']
  ],
  en: [
    [/orchestra conductor|the orchestra/gi, 'the orchestrator'],
    [/flow line|assembly line/gi, 'pipeline']
  ]
};

function fixAfterTranslate(text, target) {
  let out = text;
  (FIX_AFTER[target] || []).forEach(([re, to]) => { out = out.replace(re, to); });
  return out;
}

function protectTerms(text) {
  const found = [];
  let out = text;
  // 长词优先，避免 pm-prd 被 prd 抢先匹配
  [...KEEP_TERMS].sort((a,b)=>b.length-a.length).forEach(term => {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g');
    if (re.test(out)) {
      // 占位符实测会被模型啃掉字符（XQZ0ZQX → XZ0ZQX），所以不追求原样还原，
      // 改用「长且低频」的形式，配合下面的模糊匹配兜底
      const token = `ZZQ${found.length}QZZ`;
      out = out.replace(re, token);
      found.push(term);
    }
  });
  return { text: out, terms: found };
}

function restoreTerms(text, terms) {
  let out = text;
  terms.forEach((term, i) => {
    // 第一遍：完整形态（允许字符间插空格、改大小写）
    out = out.replace(new RegExp(`Z\\s*Z\\s*Q\\s*${i}\\s*Q\\s*Z\\s*Z`, 'gi'), term);
    // 第二遍：模型啃掉个别字符时兜底——认「若干个 Z/Q + 数字 + 若干个 Z/Q」
    out = out.replace(new RegExp(`[ZQ]{1,3}\\s*${i}\\s*[ZQ]{1,3}`, 'gi'), term);
    // 第三遍：还原后术语两侧可能粘着没吃干净的 Z/Q（实测 SKILL.mdZ）
    const esc = term.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${esc})[ZQ]{1,3}(?![A-Za-z])`, 'g'), '$1');
    out = out.replace(new RegExp(`(?<![A-Za-z])[ZQ]{1,3}(${esc})`, 'g'), '$1');
  });
  // 仍有残留说明连数字都被改了，去掉避免露出乱码
  return out.replace(/\b[ZQ]{2,4}\d{0,2}[ZQ]{0,4}\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

/* 未填名字时用 AI 起个花名。
   读评价内容来起，名字和人有点关系，比纯随机有意思。
   模型不可用或返回不合规时回落到词表组合，绝不写死「匿名」。 */
const NAME_ADJ = ['Quiet','Swift','Calm','Keen','Bright','Steady','Curious',
                  'Patient','Sharp','Warm','Nimble','Candid'];
const NAME_NOUN = ['Otter','Heron','Fox','Lark','Ibis','Marten','Finch',
                   'Badger','Crane','Vole','Shrike','Tapir'];

function fallbackName() {
  const a = NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)];
  const n = NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)];
  return `${a} ${n}`;
}

/* 校验模型产出：两个词、纯字母、长度合理，挡住模型跑题或注入 */
function sanitizeName(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // 多行说明模型在解释而不是给名字，整体拒绝——只取首行会把
  // 「Quiet\nOtter extra line」蒙混成合法的「Quiet」
  if (/[\n\r]/.test(s)) return null;
  s = s.replace(/^["'`\s]+|["'`\s.。!?]+$/g, '').trim();
  if (!/^[A-Za-z]+(?: [A-Za-z]+)?$/.test(s)) return null;
  if (s.length < 3 || s.length > 24) return null;
  // 首字母大写
  return s.split(' ').map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

async function makeHandle(env, text) {
  if (!env.AI) return fallbackName();
  try {
    const r = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
      messages: [
        { role: 'system', content:
          'You invent short anonymous handles. Reply with exactly two English words: ' +
          'an adjective and an animal noun, like "Quiet Otter". ' +
          'No quotes, no punctuation, no explanation, no numbers.' },
        { role: 'user', content:
          'Someone left this product feedback. Invent a handle that loosely fits its tone:\n' +
          String(text).slice(0, 200) }
      ],
      max_tokens: 12
    });
    return sanitizeName(r && (r.response || r.result)) || fallbackName();
  } catch (e) {
    return fallbackName();
  }
}

/* m2m100 是句子级模型，一次喂整段会丢句子——实测两句话的评价只译出后一句。
   所以按句切开逐句翻，再按原样拼回去。 */
// 英文里句点不一定是句尾：缩写、称谓、首字母缩略都会误伤
const ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|No|Fig|approx|al)\.$/i;

function splitSentences(text, lang) {
  if (lang === 'zh') {
    return text.split(/(?<=[。！？；])/).map(x => x.trim()).filter(Boolean);
  }
  // 英文：先按「标点+空白」粗切，再把误切的缩写拼回去
  const rough = text.split(/(?<=[.!?])(\s+)/);
  const out = [];
  let buf = '';
  for (let i = 0; i < rough.length; i += 2) {
    const seg = rough[i];
    const gap = rough[i + 1] ?? '';
    buf += seg;
    const next = rough[i + 2] || '';
    const isAbbrev = ABBREV.test(buf);
    // 单个大写字母后的点（首字母缩写）也不算句尾
    const isInitial = /(?:^|\s)[A-Z]\.$/.test(buf);
    // 下一段以小写开头，说明上一个点多半不是句尾
    const nextLower = /^[a-z]/.test(next);
    if (isAbbrev || isInitial || nextLower) { buf += gap; continue; }
    out.push(buf); buf = '';
  }
  if (buf.trim()) out.push(buf);
  return out.map(x => x.trim()).filter(Boolean);
}

async function translateOne(env, piece, source, target) {
  const guarded = protectTerms(piece);
  const r = await env.AI.run('@cf/meta/m2m100-1.2b', {
    text: guarded.text,
    source_lang: source,
    target_lang: target
  });
  let out = (r && r.translated_text || '').trim();
  if (!out || out.startsWith('ERROR')) throw new Error('empty piece');
  out = restoreTerms(out, guarded.terms);
  return fixAfterTranslate(out, target);
}

/* 拼接译句：缺句尾标点就补一个，中文用中文标点、英文用英文标点 */
function joinSentences(list, target) {
  const zh = target === 'zh';
  const fixed = list.map((p, i) => {
    let t = String(p).trim();
    if (!t) return '';
    // 统一半角标点为全角（中文）
    if (zh) t = t.replace(/!$/, '！').replace(/\?$/, '？').replace(/\.$/, '。');
    const last = t.slice(-1);
    const hasEnd = zh ? /[。！？；…）】」]/.test(last)
                      : /[.!?;…)\]"']/.test(last);
    // 最后一句也补，句子读完要有收束
    if (!hasEnd) t += zh ? '。' : '.';
    return t;
  }).filter(Boolean);
  return zh ? fixed.join('') : fixed.join(' ');
}

/* 翻译一条评价。结果写回 reviews 表缓存，同一条只调一次模型。 */
async function translateReview(env, id, target) {
  const row = await env.DB.prepare(
    `SELECT id, text, trans_zh, trans_en FROM reviews WHERE id = ? AND visible = 1`
  ).bind(id).first();
  if (!row) return { error: 'not found', status: 404 };

  const col = target === 'zh' ? 'trans_zh' : 'trans_en';
  if (row[col]) return { text: row[col], cached: true };

  const source = guessLang(row.text);
  // 原文已经是目标语言，直接回原文，不浪费额度
  if (source === target) return { text: row.text, same: true };

  const pieces = splitSentences(row.text, source);
  let out;
  try {
    // 逐句翻，句子之间互不影响，不会整段丢内容
    const done = await Promise.all(
      pieces.map(p => translateOne(env, p, source, target))
    );
    // 模型逐句翻译时不保证带句尾标点，直接拼会糊成一句
    //（实测三句拼出「很棒!真的有用会推荐的」）。补齐后再接。
    out = joinSentences(done, target);
  } catch (e) {
    return { error: 'translate failed', status: 503 };
  }
  if (!out) return { error: 'translate failed', status: 503 };

  await env.DB.prepare(`UPDATE reviews SET ${col} = ? WHERE id = ?`)
    .bind(out, id).run();
  return { text: out };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = env.ALLOW_ORIGIN || '*';

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // ---- 读取 ----
    if (url.pathname === '/api/reviews' && req.method === 'GET') {
      return json(await listReviews(env), 200, origin);
    }

    // ---- 下载计数 ----
    if (url.pathname === '/api/download' && req.method === 'POST') {
      await env.DB.prepare(
        `UPDATE counters SET value = value + 1 WHERE key = 'downloads'`
      ).run();
      const row = await env.DB.prepare(
        `SELECT value FROM counters WHERE key = 'downloads'`
      ).first();
      return json({ downloads: row?.value ?? 0 }, 200, origin);
    }

    // ---- 翻译评价 ----
    // 只接受库里已有的评价 id，不接受任意文本，避免被当成免费翻译 API
    if (url.pathname === '/api/translate' && req.method === 'POST') {
      let body;
      try { body = await req.json(); }
      catch { return json({ error: 'bad json' }, 400, origin); }

      const id = Number(body.id);
      const target = body.target === 'zh' ? 'zh' : 'en';
      if (!Number.isInteger(id) || id <= 0) {
        return json({ error: 'id required' }, 400, origin);
      }

      const r = await translateReview(env, id, target);
      if (r.error) return json({ error: r.error }, r.status || 500, origin);
      return json({ id, target, text: r.text, cached: !!r.cached }, 200, origin);
    }

    // ---- 提交评价 ----
    if (url.pathname === '/api/reviews' && req.method === 'POST') {
      let body;
      try { body = await req.json(); }
      catch { return json({ error: 'bad json' }, 400, origin); }

      const text = String(body.text ?? '').trim();
      if (!text) return json({ error: 'text required' }, 400, origin);
      if (text.length > MAX_TEXT) return json({ error: 'text too long' }, 400, origin);

      const links = (text.match(/https?:\/\//gi) || []).length;
      if (links > MAX_LINKS) return json({ error: 'too many links' }, 400, origin);

      const feature = clampRate(body.feature);
      const effect = clampRate(body.effect);
      const stability = clampRate(body.stability);
      if (feature === null || effect === null || stability === null) {
        return json({ error: 'ratings must be 1-5' }, 400, origin);
      }

      const given = String(body.author ?? '').trim().slice(0, MAX_AUTHOR);
      // 留空则起花名，不再写死中文「匿名」——英文界面下那三个字很突兀
      const author = given || await makeHandle(env, text);
      const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
      const ipHash = await sha256(ip + (env.SALT || 'eynap'));

      // 限流
      const recent = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM reviews
          WHERE ip_hash = ?1 AND created_at > datetime('now', ?2)`
      ).bind(ipHash, `-${WINDOW_MIN} minutes`).first();
      if ((recent?.n ?? 0) >= WINDOW_MAX) {
        return json({ error: 'too many submissions, try later' }, 429, origin);
      }

      // 重复内容
      const dup = await env.DB.prepare(
        `SELECT 1 FROM reviews WHERE text = ?1 LIMIT 1`
      ).bind(text).first();
      if (dup) return json({ error: 'duplicate' }, 409, origin);

      await env.DB.prepare(
        `INSERT INTO reviews (author, text, feature, effect, stability, version, ip_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(author, text, feature, effect, stability,
             String(body.version ?? '').slice(0, 20) || null, ipHash).run();

      return json(await listReviews(env), 200, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  }
};

/* 仅供测试引用；Workers 运行时只认 default export，额外具名导出无副作用 */
export { splitSentences, protectTerms, restoreTerms, sanitizeName,
         fixAfterTranslate, guessLang, joinSentences };
