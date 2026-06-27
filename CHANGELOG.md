# Changelog

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
