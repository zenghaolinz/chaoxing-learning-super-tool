# Changelog

## 1.5.6-image-ai-tw - 2026-11-04

### Added

- 扩展简繁中文字符匹配：支持“顯示答案”“顯示正確答案”及简繁混用文字，并兼容仅在 `aria-label`、`title`、`data-title` 或按钮值中标注的显示答案按钮；
- 翻页按钮支持“下一題 / 上一題”“下一頁 / 上一頁”“下一個 / 上一個”等繁体文字及属性提示；
- 扩展繁体题号、题型与题数识别，包括“第 N 題”“總題數”和 Vue 题型名称归一化。

### Fixed

- 答案采集排除“顯示答案”等按钮标签，避免将按钮文字当作答案；题干回退和答案分段同步兼容更多繁体标签。

### Changed

- 脚本元数据、`APP.version` 与自动刷课模块版本统一更新为 `1.5.6-image-ai-tw`。

## 1.5.5-image-ai - 2026-07-03

### Added

- **服务商预设**：一键填入 API 地址、接口类型、模型名与图片处理模式；手动改地址/模型/接口类型会自动回到「自定义」；
- 新增 Agnes、DeepSeek 官方、阿里百炼/千问 VL、火山方舟、腾讯混元、智谱 GLM、Kimi（中国区/Global）、MiniMax、OpenAI、Claude 官方、OpenRouter 等预设；
- **多模态图片题**：图片题默认优先用 Base64 发送，避免超星图片 URL 被第三方模型服务端 403；支持「自动 / 仅文字 / OCR / 多模态识图 / OCR+多模态」模式与「自动 / Base64 / 原图 URL」发送方式；
- 图片本地 OCR（基于浏览器 `TextDetector`）、图片压缩（超过限制自动缩放至 1280 边、JPEG 0.72）、视觉能力缓存（按 `apiBase|model` 记忆 7 天）；
- **Anthropic Claude `/messages` 协议支持**：新增 `chatAnthropic`，OpenAI 多模态内容块自动转换为 Anthropic `image`/`text` 块；
- **通用「打开思考」开关**：按服务商自动套用 DeepSeek V4 / Qwen(`enable_thinking`+`thinking_budget`) / Claude / MiniMax / GLM / 火山方舟 / OpenAI `reasoning_effort` / OpenRouter `reasoning` 等思考参数；接口不支持时自动去掉参数重试；
- 常见 OpenAI-compatible 地址容错：`dashscope.../compatible-mode` 自动补 `/v1`，moonshot/openai/minimax/agnes/hunyuan 等少填 `/v1` 时自动补齐；
- 「测试识图」按钮：用 1×1 测试图探测接口是否接受图片输入并缓存结果；
- Kimi K2 系列接口严格要求 `temperature=1` 的特例处理；
- 采集与答题流程透传 `images`，AI 作答结果附带 `imageModeUsed` / `imageWarning` 提示。

### Changed

- 三处版本号统一为 `1.5.5-image-ai`（header、`APP.version`、`StudyAutoPlayer.MODULE.version`）；
- `answerQuestion` 签名扩展为 `{ type, question, options, images }`，原内部流程拆分为 `runTextAnswer` / `runVisionAnswer`，识图失败后自动降级到文字+OCR；
- 设置面板新增「服务商预设」「接口类型」「图片题处理」「图片发送方式」「最多发送图片数」等控件，按钮点击前先同步输入框（修复密码框被清空时误删 API Key）；
- DeepSeek V4 思考逻辑收敛进通用 `applyThinkingControlToPayload` / `removeThinkingControlFromPayload`，并增加 `isThinkingControlError` 自动重试；
- API Key 占位文案由「DeepSeek API Key」改为通用「API Key」。

## 1.5.1 - 2026-06-27

### Added

- 脚本更名为「学习通超级工具」，合并自动刷课模块；
- **自动刷课模块（`StudyAutoPlayer`）**：视频自动播放、倍速观看、播放保活恢复、播完自动进入下一节；
- **章节测验 AI 作答**：自动刷课时检测到章节测验，调用 AI 填写答案并可选自动提交；
- 跨 iframe 上下文遍历（`_walkFrameContexts`），在 `mooc2-ans` 外壳页退出、交给 frame 内实例运行；
- 自动刷课控制合并到主浮窗面板，与采集 / 答题共用统一开关；
- DeepSeek V4 思考模式开关（`aiThinkingEnabled`）；
- AI 配置增加"测试连接"按钮；
- 采集翻页间隔可配置（`collectionDelay`）。

### Changed

- 三处版本号统一为 `1.5.1`（header、`APP.version`、`StudyAutoPlayer`）；
- 脚本文件名由 `chaoxing-answer-exporter.user.js` 改为 `chaoxing-learning-super-tool.user.js`；
- README 同步更新为「学习通超级工具」，新增自动刷课章节与安装链接。

## 1.2.4 - 2026-06-16

### Added

- AI 自动翻页答题任务持久化（`aiTaskPrefix`、`aiNavigationTimeout`）；
- 申请新权限 `unsafeWindow` 用于访问页面上下文；
- AI Prompt 简化为直接输出答案文本，不再要求 JSON 格式返回；
- 官方 DeepSeek API 自动去除 `/v1` 后缀并映射旧模型名（`deepseek-chat` → `deepseek-v4-flash`，`deepseek-reasoner` → `deepseek-v4-pro`）；
- `AIClient.resolveProviderSettings()` 统一处理 API 地址和模型配置；
- 简答题题型识别扩展（名词解释、解释题、材料分析、案例分析、翻译、写作、计算题）。

### Changed

- AI 返回结果直接解析为纯文本，不再尝试 JSON 解析；
- API Key 安全存储流程优化。

## 1.2.3 - 2026-06-16

### Added

- AI 自动翻页答题：在逐题换页模式下自动逐题调用 AI 并回填，支持跨页面断点恢复；
- `AutoFiller` 独立任务存储（`CXAE_AI_TASK_`），按试卷隔离 AI 答题进度；
- AI 答题面板增加"开始 AI 答题"和"停止"按钮；
- 按 `Esc` 可同时暂停采集和 AI 答题任务；
- 页面恢复（`pageshow`）时自动恢复 AI 答题任务。

### Changed

- AI 生成的答案同时记录到采集结果中（`source: 'ai-generated'`）；
- `AutoFiller` 支持逐题翻页答题循环（`runPagedTask`）。

## 1.2.2 - 2026-06-16

### Added

- 兼容 AI 思考模型：当 `content` 为空时，使用 `reasoning_content` 作为解析兜底；
- API 返回空内容时增加 `finish_reason` 判断（`length`、`content_filter`、`insufficient_system_resource`）；
- 无 `GM_xmlhttpRequest` 时自动回退到 `fetch` 请求。

### Changed

- 默认 API 地址改为 `https://api.deepseek.com`（去掉 `/v1` 后缀）；
- 默认模型改为 `deepseek-v4-flash`。

## 1.2.1 - 2026-06-16

### Added

- AI 自动答题：通过 DeepSeek 等 OpenAI 兼容 API 自动生成答案并回填；
- AI 答题设置面板：API 地址、API Key、模型名称、填充间隔；
- API Key 使用 `GM_setValue` / `GM_getValue` 安全存储，不写入 `localStorage`；
- 已采集答案回填功能：将采集到的正确答案自动填入当前页面对应题目；
- `AIClient` 模块：构建 Prompt、调用 API、解析响应；
- `AutoFiller` 模块：匹配题目节点并自动填写答案；
- 申请新权限：`GM_xmlhttpRequest`、`GM_getValue`、`GM_setValue`、`GM_deleteValue`；
- 新增 `@connect api.deepseek.com` 和 `@connect *`。

### Changed

- `SettingsStore` 支持敏感字段分离存储；
- 默认 AI 配置为 `deepseek-chat`，API 地址 `https://api.deepseek.com/v1`。

## 1.1.0 - 2026-06-16

### Added

- 新增随堂练习答题结果页采集模式；
- 读取 Vue 2 根实例中的 `questionList`；
- 支持从 `content`、`options` 和 `rightAnswer` 提取题干、选项与正确答案；
- 使用随堂练习活动名称作为导出文件标题；
- 为 Vue 数据异步加载增加轮询识别。

### Changed

- 页面模式扩展为逐题换页、长卷同页、随堂练习三种；
- 试卷范围识别加入 `activeId`、`activePrimaryId` 和 `quizId`。

## 1.0.0 - 2026-06-15

首个公开版本。

### Features

- 逐题换页采集与跨页面断点恢复
- 长卷同页采集与懒加载等待
- 未作答题"显示答案"处理
- 大题量题库支持
- 按试卷隔离本地采集状态
- 跳转循环保护
- Excel、Markdown 和 JSON 导出
- Shadow DOM 操作面板
- 深色模式适配
- 默认只导出题目、选项和正确答案
