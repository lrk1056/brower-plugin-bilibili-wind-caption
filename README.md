# WindCaption · 观语听风字幕

WindCaption · 观语听风字幕 —— 按 vCaptions 2.4.6 功能点裁剪复刻的浏览器插件，**仅支持 Bilibili / YouTube**、**无笔记模块**。

## 功能范围

| 模块 | 内容 |
|---|---|
| 1 字幕获取与站点适配 | Bilibili/YouTube 字幕拦截（MAIN world fetch/XHR）、ytInitialData 章节、`__playinfo__` 字幕轨道、字幕刷新、缓存持久化 |
| 2 字幕列表核心展示 | 列表视图（带时间戳、点击跳转、高亮、跟随滚动）/ 全文视图（语义合并段落、点段落跳转）、搜索筛选、多选、展开折叠、智能标点、说话人 |
| 3 翻译与双语 | AI/Google/小牛/DeepL 服务配置（BYOK，OpenAI 兼容）、全量翻译、第二字幕双语、多选批量复制/翻译、章节翻译 |
| 4 章节 | AI 生成（含描述/段落）、章节列表/上下章跳转、章节进度条、删除章节 |
| 5 复制/下载/导出 | 文稿(TXT/MD)/全文/SRT/VTT/LRC、时间戳/结构/第二字幕/无水印、内容预览、快捷下载、浏览器快捷键 Ctrl+Shift+C / D |
| 6 显示形态与布局 | 嵌入/悬浮/侧边栏、字幕条（B站）、网站配置、5 个 Tab 显隐、自动插入/展开/折叠 |
| 7 技术架构 | Manifest V3、BG SW、MAIN 世界拦截、iframe 面板 + postMessage 分层协议、localStorage 缓存 |

> 不含：账号/VIP、AI 对话、音频转录、笔记、精调、样式 Tab、Fallback 通用站点、本地字幕上传。

## 安装（Chrome / Edge）

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本项目目录（WindCaption）。
3. 打开 B站 或 YouTube 带字幕的视频，面板自动插入（可在设置关闭自动插入后点扩展图标开合）。

## 使用

- **字幕列表**：每条带时间戳，点击跳转；当前句自动高亮、跟随滚动。
- **全文视图**：点工具栏 `字幕 | 全文` 切换；句子按语义停顿合并为段落，点段落跳到开头；全文视图无时间戳/多选/折叠。
- **翻译**：设置页配置服务（API 地址 + Key + 模型），在「翻译」Tab 点立即翻译，勾选第二字幕查看双语。
- **章节**：「章节」Tab 点生成章节（需配置 AI 服务），可上下章跳转。
- **导出**：「下载」Tab 选择类型与格式，复制/下载；快捷键 Ctrl+Shift+C / Ctrl+Shift+D。

## 目录

```
manifest.json        扩展清单
background.js        后台：AI 翻译、章节生成、导出指令
lib/util.js          解析/分句/分段/导出工具
lib/storage.js       存储封装
lib/protocol.js      iframe 通信协议
inject/capture-main.js  MAIN 世界字幕网络拦截
content/             各站点适配器、面板注入、视频控制
panel/               面板 UI（5 Tab，列表/全文）
options/             设置页
icons/               图标
prototype/           交互式页面原型（设计稿）
```

## 关于 B站字幕 / 登录

- B站大量视频（包括 `BV1nJ396JEmC`）的字幕接口返回 `need_login_subtitle: true`，**必须在浏览器中登录 B站**，插件主动调用 `https://api.bilibili.com/x/player/wbi/v2`（携带页面 Cookie）才能拿到字幕列表。
- 未登录时面板会显示提示"该视频字幕需要登录 B站 才能获取"。登录并刷新页面后，字幕会自动加载。
- 拿到字幕列表后，字幕 JSON 从 `i0.hdslb.com` 拉取并解析（`{body:[{from,to,content}]}`），与官方插件逻辑一致。
- 字幕来源为站点已有的软字幕轨道；不做 OCR、不做音频转写。
- AI 功能需自带兼容 OpenAI Chat Completions 的服务（OpenAI / DeepSeek / Gemini / Ollama 等）。
- 缓存约 7 天有效，数据存于 `chrome.storage.local`。
