# dsh-request-context · 每次调用 · 请求上下文

> 独立本地插件，不改 Harness 核心，不改模型输入、不增加工具、不读取 API Key/OAuth 凭据。
> 装上它，你能逐次看清 `llm/stream` 那一刻**组装完成的完整请求**：消息与指令的先后、工具定义、token 分类占比，以及每轮对话到底发了几次请求。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

---

## 它解决什么问题

1. **上下文是个黑盒**：模型每问一次都要重发全部历史，但"这次到底发了什么、哪一类占了多少"平时看不见。
2. **token 花在哪说不清**：系统提示、工具定义、历史消息、工具结果、子代理回传各占多少？凭感觉估不准。
3. **每轮几次调用说不清**：压缩、标题生成等辅助请求混在趋势里，也看不出某一轮对话实际发生了几次模型调用。

本插件在 Harness 的 `llm/stream` 观察点上**同步**保存调用参数（在供应商适配器转换之前），落盘按内容寻址去重，并在会话标题旁提供一个可视化面板。

## 界面与能力

- 会话标题旁点击 **请求上下文**；默认 **跟随最新**，打开时每 2 秒更新列表，关闭即停止轮询。
- **可视化概览**：消息数趋势、单次与累计输入 token 估算、当前调用的分类占比与逐次变化。
- 可按类型筛选：主对话 / 压缩 / 标题生成 / 全部；查看最近 30、100 次或全部捕获调用。默认只看主对话，避免辅助请求混入趋势。
- 趋势图保留调用序号横轴，背景分区与底部"轮 N"标记真实轮次；悬停显示"第 N 轮 · 本轮第 K 次模型调用 · 执行步骤"。从轮次中途开始看图时，本轮调用次序仍按完整捕获记录计数。
- 每轮统计：**已完成轮次的平均模型调用次数**、**当前未结束轮次的调用次数**、**未关联轮次调用数**。点击轮次按钮可回看该轮首个捕获请求。
- 点击图表圆点（也支持 Tab + Enter/Space）或表格中的调用序号回看历史，自动取消"跟随最新"。
- 单次调用提供四种视图：**有序消息与指令 / 模型与调用参数 / 工具定义与历史 / 完整 JSON**。系统、developer、Agent 指令等消息默认展开；可勾选"只看非手动用户输入"（纯视图过滤，JSON 不删消息）。
- 工具展示名称、描述、完整参数 Schema，以及单独的 toolHistory。
- 可确认后导出 JSON；不提供自动上传、遥测或外部网络请求。

![请求上下文面板](docs/images/overview.jpg)

面板左侧是消息数趋势，右侧是上下文 Token 估算曲线，下方是这次调用的分类占比与每轮调用统计。

## 安装

本插件按 DSH 的**本地插件**方式安装（`link:` 依赖 + bundle 声明），不需要构建步骤、无 npm 依赖。

**1. 克隆到本地**

```powershell
git clone https://github.com/classicer/dsh-request-context.git C:\path\to\dsh-request-context
```

**2. 在 DSH profile 里登记**（`~/.dsh/profiles/<profile>/package.json`）

```json
{
  "dependencies": {
    "@local/dsh-request-context": "link:C:/path/to/dsh-request-context"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-request-context"
      ]
    }
  }
}
```

**3. 让 profile 的 `node_modules` 出现该链接**（`pnpm install`，或手工创建同名 junction/symlink 指向仓库目录）。

**4. 重启 DSH 并刷新页面**，在会话标题旁点击「请求上下文」。

### 可选：自定义数据目录

默认写在插件目录下的 `.state/default`（已在 `.gitignore` 中排除）。要放到别处，在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: local-request-context
  config:
    dataDir: 'C:/path/to/data'
```

> 命名说明：仓库按 DSH 本地插件约定使用 `@local/dsh-request-context`。若要换成自己的 scope，需要同步三处：`package.json` 的 `name`、`cordis.patch.yml` 里的 `name`、profile 依赖键与 bundles 条目。

## 精确范围与统计口径

**保存的是什么**

- 保存本插件同步 `llm/stream` 观察点收到的调用参数，属于 **Harness 组装层、供应商适配器转换之前**。
- 覆盖 `GenerateOptions` 的 provider、model、reasoningEffort、temperature、maxTokens、stop、sessionId、purpose、messages、system、tools、toolHistory。仅保存调用实际提供的字段，不补造缺省值；`AbortSignal`、未知扩展字段与认证/HTTP transport 元数据不保存，省略字段列于 `meta.omittedFields`。
- 压缩、标题等辅助调用只要有 `sessionId` 且经过 `llm/stream`，也保存其完整输入并标记对应 `purpose`。
- **这不是最终 HTTP 抓包**：下游 middleware、模型能力处理、工具更新投影、图片展开及供应商协议转换仍可能修改输入，不承诺等同线上请求体。
- 没有 `sessionId`、不经过 `llm/stream` 的调用不覆盖；插件启用前的历史没有现场快照；插件禁用期间或进程崩溃前未落盘的调用无法补记。供应商内部网络重试不算新的 Harness 调用。

**token 与消息数怎么算**

- 消息数是该次请求 `messages` 的长度，**不是用户轮数**；一次对话可以产生多次模型调用。独立 system 与工具定义不增加消息数。
- 单次与累计输入 token 均为**估算**（明确标记）：ASCII 约 4 字符/token，非 ASCII 按码点约 1 字符/token，每条消息额外 4 framing tokens；工具名、参数与有效 tools Schema 计入。**不是精确 tokenizer，也不是供应商 usage/计费量。**
- 分类（System / Developer / 工具定义 / 工具调用 / 工具结果 / Sub-agent / User / Assistant 历史 / 自动上下文 / 其他）互斥，加总等于单次估算总量；"涉及消息数"列可跨类计数，不可相加。
- Sub-agent 仅依据明确来源或前置工具调用 ID 关联识别，**不是子代理独立会话的消耗**。
- 累计值对当前筛选下全部捕获请求求和，每次重发的历史重复计入，**不等于当前上下文大小**；没有统计的调用显示"—"，累计卡片给出覆盖率。

**轮次如何关联**

- 轮次以公开 Session 的 `turn/start`、`turn/end` 为边界，步骤以 `step/start`、`step/end` 定位；依据捕获时的半开事件前缀关联，不按消息数、用户正文、时间间隔或曲线跳变猜测。
- 平均值 = 有主对话捕获记录且正常完成的轮次调用总数 ÷ 这些已完成轮次数；未结束、取消、失败、受阻的轮次不纳入均值，没有可靠数据显示"—"，不虚构零。
- 每轮只统计 `purpose=assistant` 的已捕获请求；标题生成、压缩属于辅助调用，不混入均值。**这是"已捕获调用"口径，不保证真实全部调用都被记录。**

## 隐私与安全

- 使用现有 Connection 的 Fetch 注册表，由 Harness 的 Host/Origin/浏览器认证策略保护，**不添加裸 HTTP route**；响应 `Cache-Control: no-store`。
- **本仓库不包含任何会话数据**：插件数据目录 `.state/` 与 `docs/audit/token-audit.mjs` 读取的会话日志都只留在本机，已在 `.gitignore` 中排除；统计脚本跑出来的永远是你自己机器上的数字。
- 不读取凭据服务、认证 headers 或 OAuth token——这些不属于允许保存的字段。
- 内容内常见 `Bearer`、`sk-`、JWT 及结构化秘密键会尽力遮盖；工具参数 Schema 中的字段描述保持可读。
- **脱敏不是通用 DLP 保证**：用户自然语言、工具输出、未知格式秘密仍可能保留。完整快照包含私人内容，**不要提交版本库、公开截图或公开分享导出文件**。
- 视图只使用 React 文本节点，不执行内容或注入 HTML。
- 捕获/写入与读取/统计失败通过面板的 failures 提示，不让观察器错误改变模型调用行为；坏元数据跳过，读回校验哈希。

## 开发

```
index.js            同步观察器、已认证只读 API、生命周期释放
store.js            字段白名单、脱敏、内容寻址存储、完整结构读取
client.js           会话标题旁入口与弹窗（沿用宿主 React / ReactDOM）
analytics.js        脱敏内容的纯估算函数、互斥分类与调用关联
turns.js            真实轮次事件索引、半开前缀关联与每轮捕获调用统计
cordis.patch.yml    只插入独立插件行
test.mjs            不连接模型的隔离测试
*-tests.mjs         统计 / 旧记录回填缓存 / 轮次索引 / 图表交互逻辑测试
verify-live.mjs     对本机运行中的实例做只读核对
```

```powershell
npm test     # node --test --test-isolation=none test.mjs review-tests.mjs analytics-tests.mjs turns-tests.mjs client-tests.mjs
npm run check
```

- 无安装脚本、无新增 npm 依赖；本 bundle 直接提供 plain-JS Client 文件，**无需修改或构建 Harness Web shell，也不启动第二个服务器**。
- 修改 Host 侧代码后需重新加载插件的 Host 模块并刷新原页面；本仓库不依赖 `pnpm run dev:web` watcher。
- 自动化测试不等于真实主题/布局截图验收。

## 已知限制

- 只覆盖经过 `llm/stream` 且有 `sessionId` 的调用；插件启用前的历史不可回溯。
- token 为估算值，用于比较与趋势，不能用于对账计费。
- 数据是本机明文，不会自动清理；长期使用请自行备份或在停用插件后清理。
- 快照包含私人对话内容，分享前请自行审查。

## 许可

[MIT](LICENSE) © 2026 classicer
