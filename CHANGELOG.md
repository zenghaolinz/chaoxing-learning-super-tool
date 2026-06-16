# Changelog

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
