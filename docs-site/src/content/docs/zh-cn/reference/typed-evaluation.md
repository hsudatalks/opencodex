---
title: 类型化判断（Jev）
description: 通过 Univers Gateway 调用 TypeSafe Choice、Score 和 Noul 模型。
---

Univers Gateway 分支从 `2.11.0-univers.79` 起支持 Jev 这类类型化判断模型。
这类模型接收 `state` 和 `questions`，通过专用接口返回判断结果。

- `POST /v1/evaluate`，兼容别名 `POST /v1/systemone`。
- 使用现有网关 Bearer Key；TypeSafe Key 只配置在网关服务的环境变量中。
- `GET /v1/models?capability=evaluate` 查询判断模型。普通模型列表继续用于聊天。
- 使用 TypeSafe 的 Choice / Score / Noul 契约；并非 Vercel 的 Boolean 契约。
- 复用现有鉴权、来源检查和用量记录。请求正文和判断内容不写入日志。
- 请求上限 512 KiB、100 个问题，响应上限 2 MiB；默认超时 20 秒、并发 16。
  不自动重试，不跟随重定向，不回退到聊天接口。

`univers-aip-mcp` 配置 `protocol: "typesafe"`、
`endpoint: "https://gateway.arkconsole.app/v1/evaluate"`、
`model: "typesafe/jev-1.13.0"` 和 `keyEnv: "UNIVERS_GATEWAY_API_KEY"` 即可接入。

完整网关配置、调用示例、错误码和边界以[英文参考文档](/reference/typed-evaluation)为准。
