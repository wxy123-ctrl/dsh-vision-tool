# dsh-vision-tool

极简识图插件（参考 dsh-vision-router，砍掉全部视觉后端 / 路由 / 兜底逻辑）。

## 功能

- **「+ 识图」孪生路由**：为每个已配置的模型 provider（如智谱 GLM）自动注册
  一条 `<provider>-vision` 孪生路由（目录里显示为「原名 + 识图」），声明可收
  图片。在聊天页右下角**选择带「+ 识图」的模型**即可发图——发送不再被
  「当前模型不支持图片」拦截。真正调模型时，插件把消息里的图片块（含
  tool-result 嵌套）改写成文本标记（附件 id + 指引），语言模型于是调用
  `recognize_images` 工具看图：**图片从不进入语言模型**，由语言模型经工具
  转发给识图模型。会话日志保留原图，Web UI 照常显示。provider 增删时经
  `llm/adapters-updated` 自动同步孪生。**孪生分组里的模型逐个由「设置 →
  识图模型」页的开关控制（默认全关）**：孪生 `listModels` 只放行打开的模型，
  某 provider 全关 → 空组被目录丢弃 → 整条「+ 识图」条目消失（自带多模态的
  模型保持关闭即不再出现）。
- **`recognize_images` 工具**：会话模型可一次传入 **1–10 张图片**，`images` 接受
  三种形态：① 本会话上传图片的**完整附件 ID**（`sha256:` + 64 位十六进制）；
  ② 该 ID 的**十六进制短摘要**（前 ≥8 位，如 `sha256:a5303c40`——纯文本模型
  会话里宿主图片占位文本携带的就是这种 8 位形态，按唯一前缀匹配，零命中/
  多命中时返回候选完整 ID 清单供模型一步自纠）；③ 本地图片文件路径
  （png/jpeg/webp/gif）。插件把它们转发给设置页选定的识图模型，附上固定识别
  要求（客观描述、文字原样转录、多图分「图1/图2」、不臆测、默认中文）加上
  调用方的具体要求，返回识别文本。所有图片在一次模型调用里发送。**工具按会话
  门控**：只有会话选中「+ 识图」孪生时才把它载入该会话上下文
  （`system-prompt/assemble` 权威瀑布按该步待用模型过滤请求 `tools`）；选中非
  孪生模型的会话请求里不含它（模型无法判定时保留，避免误断孪生看图链路）。
- **设置页**：「设置 → 识图模型」，与「Agent 预设」并列（order 21）。分两块，
  都写宿主 settings 的 `vision-tool` 命名空间：
  - **「+ 识图」模型选项开关列表**（识图模型下拉框**上方**）：为每个已接入模型
    （目录分组、排除孪生）提供一个 Switch，默认全关；逐项经嵌套路径 `mutate`
    （`path: ['twinEnabled', key]`）定点写单个 key，原子、按 revision 围栏，
    快速连续切换不互相覆盖。
  - **识图模型下拉**：选择当前「设置 → 模型」里已配置的 provider/model 作为
    识图模型（自动排除「+ 识图」孪生路由），选中即保存。
- **眼睛图标**：宿主设置壳的导航图标是按 section id 写死的 switch（Slot
  契约无图标位），本节不在其中、回落齿轮；浏览器半边用 MutationObserver
  做幂等 DOM 协调，把本节行的齿轮换成 ic_ds 同风格（16×16、currentColor、
  outline 环线）的眼睛 SVG——不删除 React 管理的节点（只隐藏齿轮、在其前
  插入），React 重渲染后自动重新套用，插件卸载时还原。
- **清理暂存图片**：设置页一键清理附件库（`DSH_HOME/attachments/v1`）里
  的无主对象——扫描持久化会话日志（逐行 zstd 帧解压）收集仍被引用的
  sha256 id，删除 objects 下未被任何**未归档**会话引用且写入超过 5 分钟的
  对象；tmp 下超龄残留一并回收。**已归档会话不算引用来源**：归档集在请求
  时经宿主 `workspaceRegistry` 服务读取，其日志按目录名（宿主
  `encodeSegment` 编码，插件内 `decodeSegment` 还原）整卷跳过；服务缺席
  或读取失败退化为不排除（多保留不少删，安全侧）。链路：浏览器按钮（同源
  POST）→ 宿主 webServer 命名路由
  （`/plugins/dsh-vision-tool/cleanup-attachments`，Host/Origin 信任围栏
  ——官方 `/api` `isTrustedApiRequest` 同款语义：Host 回环（或 0.0.0.0
  部署）、跨站标记拒绝、Origin 缺席放行（桌面壳经 Electron 主进程转发
  的请求没有 Origin 头）、Origin 存在须与 Host 经 URL 归一化后同权；
  仅 POST）→ 宿主半边执行并回传统计（删除/保留的数量与字节数、按已删除
  处理的归档会话数）。5 分钟新鲜度窗拦截「对象已落盘、引用尚未持久化」
  的在途写入。

## 使用流程

1. 设置 → 识图模型：为需要发图的（纯文本）模型打开「+ 识图」开关（默认全关），
   并选择一个真正的视觉模型（如 GLM-4.6V / Qwen-VL）；
2. 聊天页右下角模型选择器：切到「<你的 provider> + 识图」条目（只有打开开关的
   模型才出现）；
3. 发送图片 + 问题：语言模型收到图片标记，自动调用 recognize_images 识图——
   该工具只在选中孪生的会话里载入上下文。

**非孪生会话不携带 recognize_images**：选中不带「+ 识图」的模型时，请求 `tools`
里没有该工具（见上「工具按会话门控」），因此纯文本模型即便收到宿主 8 位占位
摘要也无法借它看图——发图请切到已打开开关的「+ 识图」孪生。工具本身仍接受任意
`sha256:<hex>` 前 ≥8 位短摘要（唯一前缀匹配）：当孪生会话历史里只剩占位文本的
8 位摘要（例如先前在纯文本模型下上传、后切到孪生的图片）时，模型无需扫附件库、
无需长路径转写即可一次调用成功；这对 PTC 模式（工具须经 `run_code` 程序调用、
转写长 ID 极易截断出错）尤其关键。

## 结构

| 文件 | 说明 |
|---|---|
| `index.js` | 宿主半边：设置命名空间 + `recognize_images` 工具（按会话门控）+ `*-vision` 孪生路由（逐模型开关过滤 `listModels`）+ 附件库清理 |
| `client.js` | 浏览器半边：设置页（`settings.section` 插槽，order 21，含「+ 识图」开关列表）+ 导航行眼睛图标 + 清理按钮 |
| `selftest.mjs` | 宿主逻辑冒烟测试（`node selftest.mjs`，19 项） |
| `eye-preview.svg` | 眼睛图标放大预览（双击浏览器打开） |
| `cordis.patch.yml` | bundle 补丁：`insert` 行 `{id: vision-tool, name: dsh-vision-tool}` |
| `locale/zh.json` `locale/en.json` | 插件页（设置 → 内置插件）卡片的中英文标题与描述（`meta.title` / `meta.description`） |
| `icon.svg` | 插件页卡片图标（package.json 顶层 `icon` 字段声明） |

## 安装（官方 bundle 安装）

```powershell
git clone https://github.com/wxy123-ctrl/dsh-vision-tool.git
# plugin_manager install_bundle  target=<克隆目录绝对路径>
# 或在 DSH Web 端「设置 → 插件」按该目录路径安装
```

`package.json` 声明 `dsh.bundle.patch`（指向本目录 `cordis.patch.yml`，
内容即 `insert` 行 `{id: vision-tool, name: dsh-vision-tool}`）——profile
以 link 方式挂上本目录并登记 bundle，补丁由 bundle 层自动合成；**无需
junction、无需手工编辑 profile 的 `cordis.patch.yml`**。schemastery
是正式 `dependencies`，由 pnpm 从 registry 安装（开发本目录时先
`pnpm install` 物化，供 selftest 解析）。浏览器半边随 HMR 实时组合进已
打开页面，改动约 1 秒热生效；宿主半边改动需热重组或重启 DSH。
卸载：`remove_bundle`。

## 验证

```powershell
dsh web --dump-config | Select-String 'id: vision-tool'
plugin_manager list_plugins   # include:vision-tool fiberPhase=active
```

GUI：设置 → 插件 → 插件清单应显示 `vision-tool` fiber active；
设置面板左侧应出现「识图模型」页（Agent 预设下方）；识图模型页下拉框**上方**
应出现分组的「+ 识图」开关列表（默认全关），打开某模型开关后聊天页模型选择里
出现它的「+ 识图」条目、关闭即消失；选中非孪生模型的会话其请求 `tools` 不含
`recognize_images`（选中孪生时含）。

## 许可证与声明

MIT，见 [LICENSE](./LICENSE)。

- 本插件为社区作品，与 DeepSeek / 深度求索不存在隶属、合作或官方背书关系；
  「DeepSeek Harness」为深度求索的商标，此处仅作兼容性引用，插件名使用
  官方推荐的 DSH 缩写。
- 本插件仅经本 GitHub 仓库分发；npm 上的同名第三方包 `dsh-vision-tool`
  （不同实现）与本仓库及其作者无关联。
