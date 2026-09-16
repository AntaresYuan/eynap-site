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
            trans_zh, trans_en,
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
    // 带上原文语种与已缓存的译文：前端据此自动显示，命中缓存就不必再请求
    reviews: (results || []).map(r => ({
      ...r,
      owner: r.author === env.OWNER,
      lang: guessLang(r.text)
    })),
    downloads: row?.value ?? 0
  };
}

/* 判断文本主体语种。
   界面只有中英两种，但评价可能是任何语言——日韩法俄西德都实测能译，
   所以这里要如实报出语种，而不是硬塞进 zh/en 二选一。
   返回 'zh' | 'en' | 其他 ISO 码（'ja'/'ko'/'ru'/'ar'…）| 'und'（无法判定）。 */
function guessLang(text) {
  const s = String(text || '');
  const n = (re) => (s.match(re) || []).length;

  const kana   = n(/[\u3040-\u309f\u30a0-\u30ff]/g);   // 平假名 + 片假名
  const hangul = n(/[\uac00-\ud7af\u1100-\u11ff]/g);
  const han    = n(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const latin  = n(/[A-Za-z]/g);
  const cyril  = n(/[\u0400-\u04ff]/g);
  const arabic = n(/[\u0600-\u06ff\u0750-\u077f]/g);
  const thai   = n(/[\u0e00-\u0e7f]/g);

  // 假名和谚文是各自语言独有的，出现即可判定——
  // 日语夹汉字很常见，必须先于汉字判断，否则会被误判成中文
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (cyril > 0) return 'ru';
  if (arabic > 0) return 'ar';
  if (thai > 0) return 'th';

  // 汉字占比超过拉丁字母的 1/4 就算中文为主
  if (han > 0 && han * 4 > latin) return 'zh';

  if (latin > 0) {
    // 拉丁字母还要区分英语和其他欧洲语言：
    // 带变音符号或西欧特有字母的，基本不是英语
    if (/[àâäçéèêëîïôöùûüÿñãõáíóúýåæøßœ]/i.test(s)) return 'eur';
    return 'en';
  }

  return 'und';   // 纯 emoji、纯数字、纯标点
}

/* 该不该给这条评价翻译成 uiLang。
   und 无法判定，翻了也是碰运气，不翻。 */
function needsTranslation(srcLang, uiLang) {
  if (!srcLang || srcLang === 'und') return false;
  if (srcLang === uiLang) return false;
  // eur 是「某种非英语的欧洲语言」，中英界面下都需要翻
  return true;
}

/* 换用指令模型后不再需要分句、占位符、逐句拼接那套补丁——
   8B 能整段理解，一次调用译完全文。
   实测每天 10000 neurons 可翻约 1280 条，比专用翻译模型 m2m100 还省，
   质量却高一个档次（m2m100 会漏句、把 orchestrator 译成「管弦乐队」）。 */
const TRANSLATE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

/* 译文长度是否明显失控。字符密度差异很大：CJK 一字顶英文数字符，
   所以要按「源语种 → 目标语种」的密度关系设阈值，不能只看目标方向。 */
function isHallucination(out, src, target, srcLang) {
  if (!out) return true;
  const o = out.length, i = src.length;
  if (i === 0) return true;
  const ratio = o / i;

  // 源语种是否属于高密度书写系统（一个字符承载的信息多）
  const denseSrc = srcLang === 'zh' || srcLang === 'ja' || srcLang === 'ko';
  const denseTgt = target === 'zh';

  let cap, floor;
  if (denseSrc && !denseTgt) {        // 密 → 疏（中/日/韩 → 英）：必然变长
    cap = i < 30 ? 6.0 : 4.0;  floor = 0.4;
  } else if (!denseSrc && denseTgt) { // 疏 → 密（英/俄/法 → 中）：必然变短
    cap = i < 30 ? 1.8 : 3.0;  floor = 0.2;
  } else {                            // 密→密 或 疏→疏：长度大体相当
    cap = i < 30 ? 3.0 : 2.5;  floor = 0.3;
  }
  return ratio > cap || (i > 20 && ratio < floor);
}

/* 指令模型偶尔会加引号、前言或把原文一起带回来，统一清掉 */
function cleanOutput(raw, sourceText) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // 常见前言：Here is the translation: / 翻译：/ Translation:
  s = s.replace(/^(?:here(?:'s| is) the translation[:：]?|translation[:：]|译文[:：]|翻译[:：])\s*/i, '');
  // 整体被引号包起来
  if (/^["'「『]/.test(s) && /["'」』]$/.test(s)) s = s.slice(1, -1).trim();
  // 模型把原文整段贴回来时只取译文部分。
  // 只在原文够长、且剔除后仍剩足够内容时才动手——否则「清晰」这种短词
  // 会把译文里的正常字抠掉，变成「技能拆分很 。」
  if (sourceText && sourceText.length >= 12) {
    const idx = s.indexOf(sourceText);
    if (idx >= 0) {
      const rest = (s.slice(0, idx) + ' ' + s.slice(idx + sourceText.length))
        .replace(/\s{2,}/g, ' ').trim();
      if (rest.length >= 4) s = rest;
    }
  }
  return s.trim();
}

/* 8B 指令模型基本能保留原样，但偶尔留着英文原词不译，
   用一张小表在译后补齐。比给弱模型打一堆补丁简单得多。 */
const FIX_AFTER = {
  zh: [
    [/\borchestrator\b/gi, '编排器'],
    [/\bpipeline\b/gi, '流水线'],
    [/\bstate machine\b/gi, '状态机'],
    [/整个管道|条管道|个管道/g, '整条流水线'],
    [/管弦乐队|管弦乐团|乐队/g, '编排器'],
    [/拨打|打电话给/g, '调用']
  ],
  en: [
    [/\bthe orchestra\b/gi, 'the orchestrator'],
    [/\bflow line\b/gi, 'pipeline']
  ]
};

function fixAfterTranslate(text, target) {
  let out = text;
  (FIX_AFTER[target] || []).forEach(([re, to]) => { out = out.replace(re, to); });
  return out;
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

/* 翻译一条评价。结果写回 reviews 表缓存，同一条只调一次模型。 */
async function translateReview(env, id, target) {
  const row = await env.DB.prepare(
    `SELECT id, text, trans_zh, trans_en FROM reviews WHERE id = ? AND visible = 1`
  ).bind(id).first();
  if (!row) return { error: 'not found', status: 404 };

  const col = target === 'zh' ? 'trans_zh' : 'trans_en';
  if (row[col]) return { text: row[col], cached: true };

  const source = guessLang(row.text);
  // 原文已是目标语言，或语种无法判定（纯 emoji 等），直接回原文不浪费额度
  if (!needsTranslation(source, target)) return { text: row.text, same: true };

  const tgt = target === 'zh' ? '中文' : 'English';
  let out;
  try {
    const r = await env.AI.run(TRANSLATE_MODEL, {
      messages: [
        { role: 'system', content:
          'You are a professional translator for software product feedback. ' +
          `Translate the user's text into ${tgt}. ` +
          'Keep technical terms, product names and identifiers (like pm-prd, SKILL.md) exactly as written. ' +
          'Translate every sentence — never omit, merge or summarize. ' +
          'Reply with the translation only: no quotes, no notes, no original text.' },
        { role: 'user', content: row.text }
      ],
      max_tokens: 600
    });
    out = cleanOutput(r && r.response, row.text);
    out = fixAfterTranslate(out, target);
    // 指令模型偶尔不翻译而是自由发挥——实测「One sentence only」被扩写成
    // 一整段关于 PM-PRD 的话。译文长度远超原文即判为幻觉，回退原文。
    if (isHallucination(out, row.text, target, source)) {
      return { text: row.text, same: true, fallback: true };
    }
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
export { sanitizeName, fixAfterTranslate, guessLang, cleanOutput,
         isHallucination, needsTranslation };
