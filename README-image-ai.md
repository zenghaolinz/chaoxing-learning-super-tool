# 学习通超级工具 · 图片题 / 多服务商预设版

版本：v1.5.5-image-ai

## 本版新增

- 增加“服务商预设”，可一键填入 API 地址、接口类型、模型名、图片处理模式。
- 支持 OpenAI-compatible `/chat/completions` 与 Anthropic Claude `/messages` 两类协议。
- Agnes、百炼、火山方舟、腾讯混元、智谱、Kimi、MiniMax、OpenAI、Claude、OpenRouter 等预设。
- 图片题默认优先用 Base64 发送，避免超星图片 URL 被第三方模型服务器访问时 403。
- 如果用户手动改 API 地址、模型、接口类型，预设会自动回到“自定义”。
- 对常见少填路径做容错：例如 `https://dashscope.aliyuncs.com/compatible-mode` 会自动补成 `/compatible-mode/v1`。
- “打开思考”从 DeepSeek 专属开关改为通用开关：会按服务商自动套用 DeepSeek/Qwen/Claude/MiniMax/GLM/OpenAI 等已知思考参数；接口不支持时自动去掉参数重试。

## 推荐配置

| 服务商 | API 地址 | 接口类型 | 模型示例 | 图片建议 |
|---|---|---|---|---|
| Agnes AI | `https://apihub.agnes-ai.com/v1` | OpenAI 兼容 | `agnes-2.0-flash` | Base64 |
| DeepSeek 官方 | `https://api.deepseek.com` | OpenAI 兼容 | `deepseek-v4-flash` | OCR |
| 阿里百炼/千问 VL | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容 | `qwen3-vl-plus` | Base64 |
| 阿里百炼业务空间 | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容 | `qwen3-vl-plus` | Base64 |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | OpenAI 兼容 | `ep-你的接入点ID` | Base64 |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | OpenAI 兼容 | `hunyuan-vision` | Base64 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容 | `glm-5v-turbo` | Base64 |
| Kimi 中国区 | `https://api.moonshot.cn/v1` | OpenAI 兼容 | `moonshot-v1-8k` | OCR；视觉模型需按控制台改模型名 |
| Kimi Global | `https://api.moonshot.ai/v1` | OpenAI 兼容 | `moonshot-v1-8k` | OCR；视觉模型需按控制台改模型名 |
| MiniMax | `https://api.minimax.io/v1` | OpenAI 兼容 | `MiniMax-M3` | Base64 |
| OpenAI | `https://api.openai.com/v1` | OpenAI 兼容 | `gpt-4.1-mini` | Base64 |
| Claude 官方 | `https://api.anthropic.com/v1` | Anthropic Claude /messages | `claude-sonnet-4-5` | Base64 |
| OpenRouter | `https://openrouter.ai/api/v1` | OpenAI 兼容 | `openai/gpt-4.1-mini` | Base64 |

## 关于“打开思考”

“打开思考”不是所有模型都能控制。新版会根据 API 地址和模型名自动选择常见参数：

- DeepSeek 官方 V4：`thinking: {type: "enabled" | "disabled"}`
- 阿里百炼/千问：`enable_thinking`，支持时附带 `thinking_budget`
- Claude 官方：Anthropic `thinking: {type: "enabled", budget_tokens: ...}`
- MiniMax M3：`thinking: {type: "adaptive" | "disabled"}`
- 智谱/GLM、火山方舟部分思考模型：尝试 `thinking.type`，不支持会自动重试
- OpenAI 官方 reasoning 模型：尝试 `reasoning_effort`

如果接口返回“不支持参数/未知参数/请求参数错误”，脚本会自动移除思考控制参数重试，避免答题直接失败。

## 关于 Agnes 控制台 403

如果控制台看到类似 `403 Forbidden https://***.com/...`，通常不是 API Key 或 API 地址错，而是模型服务端拿着图片 URL 去访问超星图片，被超星防盗链/登录态拒绝。新版预设把 Agnes 图片发送方式改成 Base64，优先由脚本在浏览器里下载图片后再传给模型。

## 安装

1. 在 Tampermonkey / 暴力猴里新建脚本或替换旧脚本内容。
2. 复制 `chaoxing-learning-super-tool.user.js` 全文保存。
3. 进入学习通题目页，打开右下角浮窗，选择服务商预设，填写 API Key，点击“测试连接”和“测试识图”。

## 注意

- 火山方舟很多场景需要填写控制台生成的 `ep-...` 接入点 ID 作为模型名。
- 阿里百炼推荐使用业务空间专属域名；通用 `dashscope.aliyuncs.com/compatible-mode/v1` 仍作为预设保留。
- Claude 官方 API 与 OpenAI Chat Completions 不同，本版已经增加 Anthropic Messages 协议支持。
- Kimi/Moonshot 的 `moonshot-v1-*` 多数是文本模型；如需识图，请按控制台已开通的多模态模型名替换。
