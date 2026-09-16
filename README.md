# Eynap 站点

[Everything You Need as an AI PM](https://antaresyuan.github.io/eynap-site/) 的展示与分发页。

技能本体在 [AntaresYuan/eynap](https://github.com/AntaresYuan/eynap)。

## 结构

```
index.html              单文件站点，零依赖、零构建
download/               分发包
worker/                 评价服务（Cloudflare Workers + D1），见 worker/README.md
```

## 三种运行模式

页面会自己判断，不需要配置：

| 模式 | 条件 | 表现 |
|---|---|---|
| 只读 | 静态托管，未配 API | 完整可读、可下载；提交评价会提示去 GitHub 提 Issue |
| 本地 | 同源有 `server.mjs` | 全功能，数据存本地 JSON |
| 联网 | `index.html` 里填了 `API_BASE` | 全功能，评价与计数存 D1 |

接入评价服务：部署 `worker/`，把 Workers 地址填进 `index.html` 顶部的 `API_BASE`。

## 许可

站点代码与技能本体同为 [CC BY-NC 4.0](https://github.com/AntaresYuan/eynap/blob/main/LICENSE)。
