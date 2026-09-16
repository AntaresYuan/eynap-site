# Eynap 评价服务

Cloudflare Workers + D1，给站点提供真实的评价与下载计数。免费额度每天 10 万行写入、
500 万行读取、5 GB 存储，这个量级远用不完。

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

提交体：

```json
{ "author": "可留空", "text": "必填", "feature": 5, "effect": 4, "stability": 5, "version": "2.0.0" }
```

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
node test.mjs               # 用 node:sqlite 模拟 D1，17 项逻辑测试
```

不需要 Cloudflare 账号，也不联网。
