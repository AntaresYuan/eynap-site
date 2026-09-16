# Eynap 评价服务

Cloudflare Workers + D1 + Workers AI，给站点提供真实的评价、下载计数和评价翻译。
D1 免费额度每天 10 万行写入、500 万行读取、5 GB 存储；
Workers AI 免费额度每天 10000 neurons，这个量级远用不完。

## 部署

```bash
npm i -g wrangler
wrangler login

cd worker
wrangler d1 create eynap          # 把返回的 database_id 填进 wrangler.toml
wrangler d1 migrations apply eynap --remote
wrangler secret put SALT          # 随便一串随机字符，用于 IP 散列
wrangler deploy
```

部署完拿到形如 `https://eynap-api.<账号>.workers.dev` 的地址，填进
`public/index.html` 顶部的 `API_BASE`：

```js
const API_BASE = 'https://eynap-api.xxx.workers.dev';
```

留空则走本地 `server.mjs`，方便开发时不联网调试。

正式上线后把 `wrangler.toml` 里的 `ALLOW_ORIGIN` 从 `*` 改成你的站点域名，
避免别的站点往你的库里写数据。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/reviews` | 返回 `{ reviews: [...], downloads: n }` |
| POST | `/api/reviews` | 提交一条，返回同上 |
| POST | `/api/download` | 下载计数 +1 |
| POST | `/api/translate` | 翻译某条评价，返回 `{ id, target, text, cached }` |

提交体：

```json
{ "author": "可留空", "text": "必填", "feature": 5, "effect": 4, "stability": 5, "version": "2.0.0" }
```

## 评价翻译

用 Workers AI 的 `@cf/meta/m2m100-1.2b` 做中英互译，不接外部翻译服务。

请求体只接受库里已有的评价 id，不接受任意文本——否则这个接口会变成别人的免费翻译 API：

```json
{ "id": 12, "target": "en" }
```

三层省额度：

1. 前端只在评价语种与当前界面不同时才显示翻译按钮，同语种不给入口
2. 后端发现原文已是目标语言就直接回原文，不调模型
3. 译文写回 `reviews.trans_zh` / `trans_en`，同一条只翻一次，之后所有人读缓存

按每条评价中英各翻一次估算，10000 neurons/天 够翻几百条新评价，实际远用不到——
评价是累积的，翻过就不再花额度。

额度耗尽时模型返回 429，接口转成 503，前端显示「翻译失败，稍后再试」并恢复按钮，
不影响评价本身的浏览和提交。

## 反垃圾

不引入第三方服务，全部在 Worker 内判定：

- 同一 IP 10 分钟内最多 3 条，超出返回 429
- 正文最长 1000 字、最多 2 个链接
- 完全重复的内容返回 409
- IP 只存 SHA-256 散列（加盐），不留明文

需要先审后发时，把建表语句里 `visible` 的默认值改成 `0`，
再用 `wrangler d1 execute` 手动放行。

## 迁移已有数据

```bash
node migrate.mjs            # 从 ../data/store.json 生成 seed.sql
wrangler d1 execute eynap --remote --file=seed.sql
```

## 本地测试

```bash
node test.mjs               # 端到端逻辑，39 项（模拟 D1 与 AI，不联网）
node test-translate.mjs     # 翻译链路边界，72 项（分句/术语/清洗/拼接）

# 线上真实模型抽查（会消耗 neurons）
bash seed-probe.sh          # 直接写库插入样本，绕过反垃圾限流
node probe-live.mjs         # 逐条翻译并核对术语与句数
```

不需要 Cloudflare 账号，也不联网。
