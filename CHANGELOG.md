# Changelog

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
- 未作答题“显示答案”处理
- 大题量题库支持
- 按试卷隔离本地采集状态
- 跳转循环保护
- Excel、Markdown 和 JSON 导出
- Shadow DOM 操作面板
- 深色模式适配
- 默认只导出题目、选项和正确答案
