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

用 `@cf/meta/llama-3.1-8b-instruct-fp8-fast` 做中英互译，不接外部翻译服务。

### 为什么不用专用翻译模型

一开始用的是 `@cf/meta/m2m100-1.2b`——名字看着最对口，实际是 2020 年的
句子级模型，1.2B 参数：

- 整段输入只翻第一句，后面直接丢
- orchestrator 译成「管弦乐队」，call 译成「拨打」，pipeline 译成「管道」
- 为了绕开这些毛病，代码里堆了分句、术语占位、译后修正三层补丁，
  仍然按下葫芦浮起瓢

换成 8B 指令模型后，那三层补丁全部删掉，质量反而更好——而且**更便宜**：

| 模型 | 输入 | 输出 | 每天 10000 neurons 可翻 |
|---|---|---|---|
| m2m100-1.2b | 31050/M | 31050/M | 约 805 条 |
| **llama-3.1-8b-fp8-fast** | 4119/M | 34868/M | **约 1282 条** |
| llama-3.3-70b-fp8-fast | 26668/M | 204805/M | 约 216 条 |

m2m100 输入输出同价，8B 输入只要它的 1/7，所以按每条约 200 token 算，
8B 反而比"专用翻译模型"多翻五成。70B 质量略好但只能翻两百条，不划算。

### 非中英语言

界面只有中英两种，但评价可以是任何语言。`guessLang` 按字符集判语种，
返回 `zh` / `en` / `ja` / `ko` / `ru` / `ar` / `th` / `eur` / `und`：

- **假名和谚文先于汉字判断**——日语夹汉字很常见，先判汉字会把日语误认成中文
- `eur` 表示"带变音符的欧洲语言"（法德西等），中英界面下都需要翻
- `und` 是纯 emoji、纯数字这类判不出来的，**不翻**，免得白花额度

实测 8B 对日、韩、俄、法、西、德都能正确互译，术语也保留。

已知限制：不带重音符的西语（"Muy util para el equipo"）会被判成英语，
靠字符集做不到更准。影响有限——中文界面下照常翻译，只有英文界面会漏。

### 省额度的三层

1. 前端只在评价语种与当前界面不同时才显示翻译按钮
2. 后端发现原文已是目标语言就直接回原文，不调模型
3. 译文写回 `reviews.trans_zh` / `trans_en`，同一条只翻一次

### 两道防护

- **输出清洗**：指令模型偶尔加前言（"Here is the translation:"）、
  引号，或把原文一起贴回来，`cleanOutput` 统一清掉
- **幻觉拦截**：实测「One sentence only」被扩写成一整段关于 PM-PRD 的话。
  按译文/原文长度比拦截，超限则回退原文。中译英天然膨胀（一个汉字顶
  好几个英文字符），所以两个方向分开设阈值

额度耗尽时模型返回 429，接口转成 503，前端显示「翻译失败，稍后再试」，
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
node test-translate.mjs     # 语种判定、清洗、幻觉防护，79 项

# 线上真实模型抽查（会消耗 neurons）
bash seed-probe.sh          # 直接写库插入样本，绕过反垃圾限流
node probe-live.mjs         # 逐条翻译并核对术语与句数
```

不需要 Cloudflare 账号，也不联网。
