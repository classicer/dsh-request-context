# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循语义化版本。

## [0.1.0] - 2026-10-06

首个公开版本。

### 新增

- 同步观察 `llm/stream`，保存 Harness 组装后的每次模型调用参数（provider、model、reasoningEffort、temperature、maxTokens、stop、sessionId、purpose、messages、system、tools、toolHistory）。
- 内容寻址去重：消息、工具定义、工具历史按 SHA-256 分块，只存一次，逐次记录只保存引用。
- 会话标题旁的「请求上下文」入口与弹窗：有序消息与指令、模型与调用参数、工具定义与历史、完整 JSON 四种视图。
- 可视化概览：消息数趋势、单次与累计输入 token 估算、互斥分类占比（System / Developer / 工具定义 / 工具调用 / 工具结果 / Sub-agent / User / Assistant 历史 / 自动上下文 / 其他）。
- 轮次统计：平均每轮主对话调用次数、当前未结束轮次调用次数、未关联轮次调用数，基于 `turn/start`、`turn/end`、`step/start`、`step/end` 真实事件关联。
- 隐私保护：不读取凭据服务与认证头，尽力遮盖内容中的 `Bearer`、`sk-`、JWT 与结构化秘密键；仅使用现有 Connection 的已认证只读 API，`Cache-Control: no-store`。
- 无 npm 依赖、无安装脚本、无外部网络请求、无遥测。
