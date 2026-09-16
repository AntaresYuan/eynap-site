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

  let out;
  try {
    const r = await env.AI.run('@cf/meta/m2m100-1.2b', {
      text: row.text,
      source_lang: source,
      target_lang: target
    });
    out = (r && r.translated_text || '').trim();
  } catch (e) {
    return { error: 'translate failed', status: 503 };
  }
  if (!out || out.startsWith('ERROR')) return { error: 'translate failed', status: 503 };

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

      const author = String(body.author ?? '').trim().slice(0, MAX_AUTHOR) || '匿名';
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
