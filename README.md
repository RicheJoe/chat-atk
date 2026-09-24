# chat-atk

本机桌面应用，当前演示的是商标注册流程客服。界面是 Vue 3，窗口由 Electron 打开。回复由本机 [Ollama](https://ollama.com) 流式生成。回答前会先检索 `knowledge/trademark/` 里的资料；问类别、材料或官费时，再调用本机三个工具。对话存在本机 JSON 文件里，不经过云端。

默认系统提示是「你是知识产权流程客服，用中文回答。」界面优先选用聊天模型 `qwen2.5:7b`，本机没有这个模型时改用已安装列表里的第一个。检索用的是另一个模型 `bge-m3`，它也会出现在下拉框里，不要拿它来生成回复。

## 先准备什么

1. Node.js（建议 20+）和 npm。
2. 已安装并正在运行的 Ollama。开发环境地址在 `.env.development`，默认 `http://127.0.0.1:11434`。测试环境地址在 `.env.test`。
3. 两个模型都要拉过。聊天用 `qwen2.5:7b`，把问题变成向量用 `bge-m3`：

```bash
ollama pull qwen2.5:7b
ollama pull bge-m3
```

Ollama 没启动，或一台机器上都没有模型时，顶栏下拉框会显示「模型服务未启动」或「无本地模型」，发送按钮不可用。

## 怎么跑

```bash
npm install
npm run dev          # 开发，读 .env.development
npm run dev:test     # 测试，读 .env.test
```

开发时会同时起来三块：

| 进程 | 作用 |
| --- | --- |
| Electron 主进程 | 开窗口、存对话、调 Ollama |
| Preload | 把 Electron API 挂到渲染进程 |
| Vue 渲染进程 | 侧边栏和聊天界面，热更新 |

打包：

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

`npm start` 预览已构建的应用。`npm run lint` / `npm run format` 做检查和格式化。

推荐用 VS Code，并安装 ESLint、Prettier、Volar。

## 界面上能做什么

- **新对话**：左侧按钮。第一条用户消息的前 18 个字会变成标题。
- **切换 / 删除对话**：点列表项切换；删除当前对话时，若正在生成会先停掉。列表空了会自动再建一条空对话。
- **选模型**：顶栏下拉框，数据来自本机 Ollama。生成过程中不能切换。
- **发送**：输入框回车，或点「发送」。助手气泡会逐段长出来，标题、列表、加粗和链接按 Markdown 显示。用户自己的消息仍是纯文本。
- **依据**：这次检索命中的资料标题和日期显示在气泡底部。重新打开对话后还在。
- **正在查询**：模型调用工具时，气泡上方先显示「正在查询：候选类别 / 材料清单 / 费用」，完成后改成「已查询」。这和底部的检索依据分开。重新打开对话后查询记录还在。
- **停止**：中断当前这次生成。还没收到任何字就停掉时，那条空的助手消息不会留下。已经生成的文字会连同当时的依据和查询记录一起保存。

切换对话前，如果上一条还在生成，会先停止并保存。

## 代码怎么串起来

Electron 把代码分成三个入口，配置在 `electron.vite.config.mjs`。

```text
src/renderer   Vue 界面（浏览器环境，能用 fetch，不能直接读文件）
src/preload    安全桥，渲染进程通过它使用 Electron API
src/main       Node 环境：Express、Ollama SDK、写磁盘
```

发一条消息、创建会话、拉历史都走本机 Express：

```text
chatContent.vue / App.vue
  fetch http://127.0.0.1:8787/api/conversations...
       │
       ▼
prepareContext                       超长时先摘要旧消息
       │
       ▼
retrieve                             用 bge-m3 在本地知识库取最多 3 段
       │
       ▼
streamChat → Ollama                  需要时调用本地工具，再把结果组织成回复
       │
       ▼
SSE                                  chunk / tool / sources 回给界面
```

检索失败时这次不附资料，仍然继续生成。资料正文和工具返回的 JSON 只放进这一次请求，不写入会话历史。

模型列表同样直接请求 Express：

```text
GET http://127.0.0.1:8787/api/models
```

`src/renderer/index.html` 的 CSP 只放行了这个地址，换端口或换主机时要一起改。

主进程启动时调用 `startBff()`（`src/main/bff/index.js`），只监听 `127.0.0.1:8787`。窗口全部关掉时（macOS 除外）会退出，退出前关掉这个服务。

## 目录

```text
src/main/index.js                 窗口，启动 Express
src/main/conversations.js         对话读写
src/main/bff/index.js             Express，端口 8787
src/main/bff/chat.js              把模型输出转成 chunk / done 事件
src/main/bff/context.js           上下文裁剪和摘要
src/main/bff/knowledge.js         切块、建索引、检索
src/main/bff/tools.js             候选类别、材料清单、费用三个本地工具
src/main/bff/routes/models.js     GET /api/models
src/main/bff/routes/conversations.js  会话的创建、查询、删除和发消息
src/main/bff/providers/           模型供应商，现在只有 ollama
src/preload/index.js              Electron 安全桥
src/renderer/src/App.vue          侧边栏、当前对话
src/renderer/src/bffClient.js     调本机 Express
src/renderer/src/components/chatContent.vue   消息列表、输入、流式更新
src/renderer/src/conversation.js  默认标题
knowledge/trademark/              商标资料，一篇一个主题
knowledge/.chroma-stamp           上次写入 Chroma 的模型名，用来判断要不要重建
```

`Versions.vue` 是脚手架自带组件，当前界面没有用到。

## 对话存在哪

文件是 Electron `userData` 目录下的 `conversations.json`。macOS 开发时一般是：

```text
~/Library/Application Support/my-ai-chat/conversations.json
```

写入按队列排队，避免两次保存互相覆盖。读到坏文件或文件不存在时，当成空列表。

一条对话长这样：

```js
{
  id: 'conv_...',          // 时间戳 + 随机串
  title: '新对话',
  updatedAt: 1710000000000,
  summary: '',             // 被裁掉的旧对话摘要
  summarizedCount: 0,      // 这份摘要已经覆盖了多少条被丢掉的消息
  messages: [
    { role: 'system', content: '你是知识产权流程客服，用中文回答。' },
    { role: 'user', content: '...' },
    { role: 'assistant', content: '...',
      queries: [{ name: 'list_materials', label: '材料清单', status: 'done' }],
      sources: [
        { title: '资料标题 / 小节标题', updated: '2026-09-23', source: 'https://...' }
      ] }
  ]
}
```

保存时会丢掉内容为空的消息。带 `error: true` 的助手消息会留下来（界面上能看到失败原因），但下次发给模型时会过滤掉。系统消息始终保留。`sources` 和 `queries` 只给界面显示，下次发给模型时不会带上。

侧边栏列表只拿 `id`、`title`、`updatedAt`，按更新时间从新到旧排。

摘要有一个保护：如果界面上的 `summarizedCount` 比磁盘上的旧，保存时沿用磁盘里的摘要，避免一次过期保存把主进程刚写好的摘要盖掉。

## 上下文为什么会被摘要

`src/main/bff/context.js` 在真正请求模型前整理历史。预算大约 6000 个字符（按字数粗算，不是模型官方 token）。

- 没超预算：系统提示 + 全部历史直接送出。
- 超了：从最新消息往前保留，旧消息先不送。已有摘要会作为第二条 system 消息附上，摘要正文最多用 400 字。
- 新丢掉的消息比 `summarizedCount` 多时，用当前模型再跑一次非流式请求，把旧摘要和新增对话压成 300 字以内的中文摘要，然后写回这条对话。
- 摘要失败或用户中途停止：这次仍用裁剪后的历史回答，不更新摘要。

改预算、摘要字数或系统提示默认值，就改这个文件里的 `TOKEN_BUDGET`、`SUMMARY_RESERVE`、`DEFAULT_SYSTEM`。新建对话时的系统提示在 `src/main/conversations.js` 的 `SYSTEM_PROMPT`，两处要一起改，否则新对话和超长裁剪会各用各的提示。

## 知识库怎么检索

资料放在 `knowledge/trademark/`。一篇一个 Markdown，文首是 `id`、`title`、`updated`、`source`。正文按二级标题切块，一块就是一个 `##` 到下一个 `##` 之前的内容。没有二级标题的文件不会产生知识块。文首写 `index: false` 的文件整篇跳过。

向量存在本机 Chroma 的 `trademark` 集合里，地址是 `http://127.0.0.1:8000`。先启动 Chroma，再发消息。距离用余弦。集合如果已经按别的距离建过，下次重建会删掉它再按余弦创建。

`knowledge/.chroma-stamp` 记下上次用的向量模型。Markdown 比这个文件新、模型名变了、集合是空的，或距离不是余弦时，用 `bge-m3` 把「标题 + 正文」重新写入。已经从资料里删掉的段落会从集合里去掉。开发时工作目录要在项目根，否则找不到 `knowledge/`。

检索只看当前这条用户消息。取得分最高的 3 块；Chroma 的余弦距离换成相似度后，低于 `0.7` 的不附。阈值和条数在 `src/main/bff/knowledge.js` 的 `SCORE_MIN`、`TOP_K`。命中后，在历史和当前问题之间插入一条临时系统消息：流程和期限只根据这些资料回答，费用和材料以工具返回为准，日期要带上，不判断能否注册或是否侵权。没有命中时，这条消息要求不要凭记忆回答费用、期限和材料。

主进程日志会打出这 3 块的分数和标题。改完资料后的第一条消息会重建索引，会比平时慢。

## 三个工具

类别、材料和官费不靠检索正文，走 `src/main/bff/tools.js` 里的本地规则。模型用 LangChain 的 `bindTools` 决定要不要调用；一次回复最多执行一轮，再把 JSON 组织成中文。

| 工具 | 界面名称 | 输入 | 返回 |
| --- | --- | --- | --- |
| `suggest_class` | 候选类别 | 商品或服务描述 | 只在第九、二十五、三十、三十五、四十三类里给候选。对不上就说明未覆盖 |
| `list_materials` | 材料清单 | 申请人类型 | 国内自然人、国内法人、其他组织、农村承包经营户的清单。认不出类型时要求先问清 |
| `estimate_fee` | 费用 | 类别数 | 当前摘录没有金额。`recorded` 为 false，`amount` 为空。问多少钱必须调用，不能心算 |

工具说明在同文件的 `toolGuide` 里，每次请求都会附上。`estimate_fee` 写明未收录时，回复里不能出现金额。

## HTTP 接口

服务只绑本机 `127.0.0.1:8787`。

**GET `/api/models`**

界面启动时调用。成功：

```json
{ "models": [{ "name": "qwen2.5:7b", "size": 0, "parameterSize": "7.6B", "modifiedAt": "" }] }
```

Ollama 连不上时返回 502。

**POST `/api/conversations`**

创建一条空会话，返回完整对象，里面已有系统提示。

**GET `/api/conversations`**

侧边栏列表，只有 `id`、`title`、`updatedAt`。

**GET `/api/conversations/:id`**

一条完整会话。不存在时 404。

**DELETE `/api/conversations/:id`**

删除会话，成功时 204。

**POST `/api/conversations/:id/messages`**

发送一条用户消息。服务端先把这条消息存下来，再走 `prepareContext`、知识库检索和 `streamChat`。响应是 SSE（`text/event-stream`），每行 `data: {JSON}`。客户端断开连接会中止生成，已经生成的文字和当时的依据会写入这条会话。

请求体：

```json
{
  "model": "qwen2.5:7b",
  "content": "你好"
}
```

事件：

| type | 字段 | 含义 |
| --- | --- | --- |
| `sources` | `sources` | 这次命中的依据，元素含 `title`、`updated`、`source`。没有命中时是空数组，出现在第一个 `chunk` 之前 |
| `tool` | `name`, `label`, `status` | 工具开始是 `running`，结束是 `done`。`label` 是「候选类别」「材料清单」或「费用」 |
| `chunk` | `content` | 增量文本 |
| `summary` | `summary`, `summarizedCount` | 刚更新的摘要 |
| `done` | `title` | 正常结束 |
| `error` | `message` | 失败原因 |

`content` 和 `model` 必填，否则 400。会话不存在时 404。

## 改界面时看哪里

聊天相关的界面状态都在两个 Vue 文件里，没有 Vue Router，也没有 Pinia。

- `App.vue`：对话列表、当前对话 `active`。创建、切换、删除都请求 Express。`ChatContent` 通过 `@change` 把标题和流式消息交回来，用来更新侧边栏。
- `chatContent.vue`：输入、模型、流式拼字、停止。父组件用 `ref` 调用 `stopStreaming`（切换或删除对话时）。
- 样式都写在各自的 `<style scoped>` 里。整体是深色、左右分栏，侧边栏宽 220px。

改完界面后在 `npm run dev` 里走一遍：发消息、看字逐段出现、停止、切换对话、删除、重启应用后历史还在。

## 加一个模型供应商

现在只有 Ollama，注册表在 `src/main/bff/providers/index.js`。

新供应商导出三个函数，再放进 `providers` 对象：

- `listModels()`：返回 `{ name, size, parameterSize, modifiedAt }[]`
- `chat({ model, messages, signal })`：异步生成器，逐段 `yield` 文本；`signal` abort 时停掉上游请求
- `complete({ model, messages, signal })`：非流式，返回整段字符串，给摘要用

发消息和模型列表目前都固定走 `ollama`。接上新供应商后，`POST /api/conversations/:id/messages` 和 `GET /api/models` 要能按 `provider` 选择，否则注册了也不会被界面用到。

Ollama 地址来自环境变量 `VITE_OLLAMA_HOST`。`npm run dev` 用 `.env.development`，`npm run dev:test` 用 `.env.test`。未配置时回退到 `http://127.0.0.1:11434`。本机临时改地址可以写 `.env.development.local` 或 `.env.test.local`，这两个文件不进仓库。

## 常见问题

**下拉框是「模型服务未启动」**
Ollama 没开，或当前模式的 `VITE_OLLAMA_HOST` 连不上。开发模式先在终端执行 `ollama list` 确认。主进程日志里会有 `BFF http://127.0.0.1:8787`；8787 被占用时应用起不来。

**有 Ollama 但发不出去**
本机没有聊天模型。执行 `ollama pull qwen2.5:7b`。想改默认优先模型，改 `chatContent.vue` 里的 `PREFERRED_MODEL`。

**回复没有依据，或主进程报 embedding 失败**  
Chroma 没开在 `127.0.0.1:8000`，或没拉 `bge-m3`。拉好模型后删掉 `knowledge/.chroma-stamp`，再发一条消息，让它按当前的 `EMBED_MODEL` 重建集合。

**回复中断或报错出现在气泡里**
那条消息带 `error: true`，会保存，但不会再送给模型。看主进程终端里的报错，常见是模型名不存在或 Ollama 中途退出。

**重启后对话没了**
看的是另一份 userData。开发版和打包版的应用名都是 `my-ai-chat`，目录应一致。可以直接打开上面的 `conversations.json` 检查。
