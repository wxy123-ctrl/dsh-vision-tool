// dsh-vision-tool — host half.
//
// 一个极简识图插件（参考 dsh-vision-router 的工具链路，砍掉全部视觉后端/
// 路由/兜底逻辑）：向会话模型注册一个 `recognize_images` 工具，把会话里
// 用户上传的图片（附件 ID）或本地图片文件一次性转发给「设置 → 识图模型」
// 里选定的视觉模型，并附上固定的识别要求，返回识别文本。
//
// 附件 ID 解析是三层互补结构（agent/pre-step 索引 → 会话日志四形态扫描 →
// 全局 LRU 兜底），详见下方「附件 ID → ImageAttachmentRef 解析」注释块。
//
// 识图模型的选择持久化在宿主 settings（0.1.7 架构）：命名空间由条目 Config
// 自动派生（ns = entry id = `vision-tool`，仅 volatile 字段进入设置表单与
// 写入白名单），浏览器半边经 ctx.configForms 读写，写入落 profile
// cordis.patch.yml 的该条 override；宿主按官方范式在调用时经 .get() 实时
// 读取（volatile ref 原位更新、apply 不重挂）。
//
// 挂载：官方 bundle——package.json 声明 dsh.bundle.patch（cordis.patch.yml），
// 经 plugin_manager install_bundle 安装进 profile，两半结构完整；
// schemastery 是正式 dependencies（registry 安装，本目录 node_modules
// 经 pnpm install 物化）。

import z from '@deepseek-ai/schemastery'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-vision-tool'

export const Config = z.object({
  // 识图模型路由（来自 设置 → 模型 中已配置的 provider/model）。
  // ⚠️ 三字段必须全部 .volatile()（0.1.7 设置契约）：设置命名空间只服务
  // volatile 字段（volatileForm 无 volatile 字段时整个条目被 describe
  // 跳过 → 页面「命名空间不可用」），写路径也只放行 volatile 路径；
  // volatile 让设置页写入原位更新、不重挂本插件（官方同款链式顺序）。
  visionProvider: z.string().default('').volatile(),
  visionModel: z.string().default('').volatile(),
  // 每个已接入模型的「+ 识图」孪生选项开关，key = encodeTwinKey(provider, model)
  // （基础 provider 与模型 id，与设置页分组列表一致）。缺省（空记录）= 全关：
  // 孪生 listModels 不再列出该模型，聊天页模型选择里的「xxx + 识图」条目随之
  // 消失（provider 全部关闭 → 分组为空 → 目录丢弃空组 → 整条孪生消失）。
  // 注意：schemastery 用 z.dict（值在前、键默认 string），不是 zod 的 z.record。
  twinEnabled: z.dict(z.boolean()).default({}).volatile(),
})

const TOOL_NAME = 'recognize_images'

/**
 * 一个基础模型在孪生开关记录里的 key：provider + 模型 id 的 JSON 数组串。
 * 宿主（孪生 listModels 过滤）与浏览器半边（开关读写）各自定义同款编码，
 * 两侧对同一模型算出同一 key。JSON 字符串作对象 key，JSON/YAML 存储安全。
 * @param provider - 基础 provider 路由 id（不含 -vision 孪生后缀）。
 * @param model - 该 provider 下的模型 id。
 * @returns 稳定的记录 key。
 */
const encodeTwinKey = (provider, model) => JSON.stringify([provider, model])
const MAX_IMAGES = 10
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

// ── 路由信任围栏（官方 /api 同款语义的内联副本）────────────────────────────
//
// 官方 /api 路由的 Host/Origin 围栏在 packages/client/connection/src/
// api-request-trust.ts（isTrustedApiRequest），语义四条：
//   1) Host 必须可解析为 authority，回环绑定的部署里 hostname 必须回环
//      （DNS-rebinding 防御：rebound 请求的 Host 是攻击者域名）；
//   2) sec-fetch-site: cross-site 显式跨站标记直接拒绝；
//   3) Origin 缺席视为可信——桌面 GUI 的 dsh-app://app 壳经 Electron 主进程
//      转发（apps/desktop/src/web-document.ts forwardWebRequest）时
//      host/origin/sec-fetch-site 会被删除，端点必须放行这种请求；
//   4) Origin 存在则与 Host 经 URL 归一化后同权比较（默认端口/大小写归一，
//      'null' 解析失败拒绝）。
// 独立插件无法 import 该官方包内模块，就地内联同一判定（纯函数零依赖）。

/**
 * 单个请求头的字符串值；数组形态（畸形请求）按缺失处理。
 * @param req - node:http 请求。
 * @param name - 头名（小写）。
 * @returns 字符串值，或 undefined。
 */
const headerValue = (req, name) => {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * 是否回环 hostname（localhost / [::1] / 127/8 内任意 IPv4）。
 * 与官方 loopback-hostname.ts 同款；hostname 来自 WHATWG URL 解析，
 * IPv6 字面量保留方括号。
 * @param hostname - URL 解析出的 hostname。
 * @returns 回环则 true。
 */
const isLoopbackHostname = (hostname) => {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 官方 /api 信任围栏的内联同款：清理端点共用。Origin 缺席放行（桌面壳
 * 转发即此形态），Origin 存在须与 Host 同权；Host 非回环仅在 0.0.0.0
 * 部署（lanDeployment）放行；显式跨站标记一律拒绝。
 * @param req - node:http 请求。
 * @param lanDeployment - webServer 绑定 0.0.0.0（局域网可达）时为 true。
 * @returns 请求可信则 true。
 */
const isTrustedPluginRequest = (req, lanDeployment) => {
  const hostHeader = headerValue(req, 'host')
  if (hostHeader === undefined) return false
  let hostUrl
  try { hostUrl = new URL(`http://${hostHeader}`) } catch { return false }
  const loopback = isLoopbackHostname(hostUrl.hostname)
  if (!loopback && !lanDeployment) return false
  if (headerValue(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(req, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

// ── 附件库清理（设置页「清理暂存图片」按钮的宿主侧）───────────────────────
//
// 识别链路会在附件库（DSH_HOME/attachments/v1）持续落盘规范化副本：用户
// 上传、read_image 重存、recognize_images 的本地文件路径转存。会话删除后
// 这些对象就成了无主暂存。清理策略：扫描全部持久化会话日志收集仍被引用
// 的 sha256 id，objects 下「未被任何会话引用且写入超过 5 分钟」的对象即
// 视为暂存垃圾删除；tmp 下超龄残留同样回收。5 分钟新鲜度窗拦截「对象已
// 落盘、引用尚未持久化」的在途写入。定位逻辑复刻宿主 attachment-local
// （显式 dshHome → DSH_HOME 环境变量 → ~/.dsh）。
//
// 已归档会话（workspace 注册表 archivedSessionIds 集合）不算引用来源：
// 归档是单向隐藏、无解除入口，其图片永远不会再被读取，日志按目录名匹配
// 后整卷跳过。归档集经 ctx.workspaceRegistry 服务在请求时读取——它是对
// 存储后端的权威投影，比直接解析 storages/ 磁盘布局稳。服务缺席或读取
// 失败时按空集处理（退化为旧行为：多保留、不少删，安全侧）。

const ZSTD_MAGIC_0 = 0x28
const ZSTD_MAGIC_1 = 0xb5
const ZSTD_MAGIC_2 = 0x2f
const ZSTD_MAGIC_3 = 0xfd
const isZstdFrameStart = (buffer, at) =>
  buffer[at] === ZSTD_MAGIC_0
  && buffer[at + 1] === ZSTD_MAGIC_1
  && buffer[at + 2] === ZSTD_MAGIC_2
  && buffer[at + 3] === ZSTD_MAGIC_3

/** DSH 主目录：DSH_HOME 环境变量优先，缺省 ~/.dsh（宿主同款语义）。 */
export function dshHomeOf(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME !== ''
    ? resolve(env.DSH_HOME)
    : join(homedir(), '.dsh')
}

/**
 * 解压会话日志（宿主持久化格式：逐事件一帧 zstd，帧直接首尾相接）。
 * 贪婪扫描下一帧魔数定位边界——压缩数据理论上可能含魔数序列，但宿主
 * 按帧写入，逐帧起点扫描在真实日志上逐帧全解成立；坏帧直接截停。
 * @returns 解压拼接后的完整字节。
 */
export function decompressSessionLog(buffer) {
  const chunks = []
  let pos = 0
  while (pos + 4 <= buffer.length && isZstdFrameStart(buffer, pos)) {
    let next = pos + 1
    while (next + 4 <= buffer.length && !isZstdFrameStart(buffer, next)) next++
    if (next + 4 > buffer.length) next = buffer.length
    chunks.push(zstdDecompressSync(buffer.subarray(pos, next)))
    pos = next
  }
  return Buffer.concat(chunks)
}

/** 会话日志文本里引用的全部附件摘要（sha256:<hex> 的 hex 部分）。 */
export function collectReferencedIds(buffer, into) {
  const text = decompressSessionLog(buffer).toString('utf8')
  for (const hit of text.matchAll(/sha256:([0-9a-f]{64})/g)) into.add(hit[1])
}

/**
 * 宿主 encodeSegment 的逆映射：会话目录名里的 `~XXXX`（4 位大写十六进制）
 * 还原为原字符，安全字符原样保留。宿主编码时 `~` 本身也会转义，所以编码
 * 结果里 `~XXXX` 只可能是转义序列，解码无歧义。归档集匹配用它把磁盘
 * 目录名还原成会话 id。
 * @param segment - 会话日志所在目录名（编码后的会话 id）。
 * @returns 原始会话 id 字符串。
 */
export function decodeSegment(segment) {
  return String(segment).replace(/~([0-9A-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

/** 递归列出 root 下全部普通文件路径（root 不存在 → 空表）。 */
async function listFilesRecursive(root) {
  const out = []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return out
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * 执行一次附件库清理。
 * @param options - home（DSH 主目录）、archivedIds（已归档会话 id 集合，
 *   这些会话的日志不参与引用扫描，默认空集 = 不排除）、minAgeMs（新鲜度
 *   窗，默认 5 分钟）、now（当前时刻，默认 Date.now()）。
 * @returns 扫描/跳过归档的会话数、被引用 id 数、删除/保留的对象数与字节数。
 */
export async function cleanupAttachments({ home = dshHomeOf(), archivedIds = new Set(), minAgeMs = 5 * 60_000, now = Date.now() } = {}) {
  const referenced = new Set()
  let scannedSessions = 0
  let skippedArchivedSessions = 0
  for (const file of await listFilesRecursive(join(home, 'sessions'))) {
    if (!file.endsWith('.jsonl.zstd')) continue
    // 日志父目录名即编码后的会话 id（宿主 sessionDir 语义）；命中归档集
    // 整卷跳过——归档会话不可达，其引用不构成保留理由。
    if (archivedIds.has(decodeSegment(basename(dirname(file))))) {
      skippedArchivedSessions += 1
      continue
    }
    try {
      collectReferencedIds(await readFile(file), referenced)
      scannedSessions++
    } catch {
      /* 单个会话日志损坏不阻断整体清理 */
    }
  }
  const countTree = async (root) => {
    let removedCount = 0
    let removedBytes = 0
    let keptCount = 0
    let keptBytes = 0
    const shards = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const shard of shards) {
      if (!shard.isDirectory()) continue
      const entries = await readdir(join(root, shard.name), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
        const full = join(root, shard.name, entry.name)
        try {
          const info = await stat(full)
          if (referenced.has(entry.name) || now - info.mtimeMs < minAgeMs) {
            keptCount += 1
            keptBytes += info.size
            continue
          }
          await unlink(full)
          removedCount += 1
          removedBytes += info.size
        } catch {
          /* 与并发写入/读取竞态：跳过该对象 */
        }
      }
    }
    return { removedCount, removedBytes, keptCount, keptBytes }
  }
  const objects = await countTree(join(home, 'attachments', 'v1', 'objects'))
  return { scannedSessions, skippedArchivedSessions, referencedCount: referenced.size, ...objects }
}

/** 附件 ID 形如 "sha256:<hex>"（宿主上传图片的持久引用形式）。 */
const ATTACHMENT_ID_RE = /^[a-z0-9]+:[0-9a-f]{32,}$/i

/**
 * 任意长度的 "sha256:<hex>" 形态一律走附件语义：宿主给纯文本模型的图片占位
 * 文本只带 8 位摘要（dsh-llm 的 textOnlyImageText），PTC 模式下模型往程序里
 * 转写 id 也可能截断。这类输入绝不能落入文件路径分支——线上事故里它们被当
 * 相对路径解析，报出误导性 cannot read，恰好绕开了列出完整 ID 清单、可一步
 * 自纠的「未知附件 ID」诊断。
 */
const SHA256_FORM_RE = /^sha256:[0-9a-f]+$/i

const IMAGE_EXTENSIONS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function mediaTypeOf(path) {
  const match = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? IMAGE_EXTENSIONS[match[1]] : undefined
}

/** 附件存储无扩展名，按魔数嗅探格式（png/jpeg/webp/gif）。 */
function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  const head = (offset, count) => {
    const parts = []
    for (let i = offset; i < offset + count; i++) parts.push(bytes[i].toString(16).padStart(2, '0'))
    return parts.join('')
  }
  if (head(0, 8) === '89504e470d0a1a0a') return 'image/png'
  if (head(0, 3) === 'ffd8ff') return 'image/jpeg'
  const riff = head(0, 4)
  const webp = head(8, 4)
  if (riff === '52494646' && webp === '57454250') return 'image/webp'
  if (riff === '47494638') return 'image/gif' // GIF87a / GIF89a
  return undefined
}

// ── 附件 ID → ImageAttachmentRef 解析（三层互补）──────────────────────────
//
// 宿主 attachments.readImage(ref) 校验 ref 的全量元数据（sha256 摘要 +
// mediaType/bytes/width/height），不能只凭 id 合成 ref——必须拿到会话里
// 出现过的完整引用对象。单一来源在世代更替中都可能失明（本轮线上事故：
// exec.agent.session 链路整体拿不到，事件日志里明明有 user/message 图片块），
// 因此按 dsh-vision-router 的纵深做法三层互补：
//
// ① agent/pre-step 索引：scoped waterfall 事件（payload {agent, messages,
//    turn, step, signal}）每步把 claimed 消息里的图片引用提前记入索引——
//    事件直接送达插件，不依赖 exec 形状、不依赖会话访问器；
// ② 会话日志扫描：snapshotEvents()/events 原始日志优先（含
//    agent/inbox/spliced 队列插入、tool/result、assistant/chunk block-end
//    四种载荷形态——宿主 session-controller referencedImage 同款覆盖），
//    deriveMessages() 派生消息垫底；
// ③ 全局有界 LRU：附件 id 内容寻址（sha256）全局唯一，跨会话兜底。
//
// 三层全空时返回带诊断的报错（哪些链路可用、扫到几个事件/附件），让下一
// 次失败能直接定位，而不是再猜一轮。
//
// 短摘要：模型在纯文本模型会话（未选「+ 识图」孪生）里往往只能拿到宿主占
// 位文本携带的 8 位摘要，PTC 程序转写也常截断 id。任意 "sha256:<hex>" 形态
// 按小写化的前缀在上述三层里做唯一匹配；零命中/多命中返回候选完整 ID 清单
// 供调用方一步自纠。

const RECENT_REF_LIMIT = 128

/** 从 content 块（含 tool-result 嵌套）收集图片附件引用到 Map(id -> ref)。 */
function collectRefsFromContent(content, into) {
  for (const block of content ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image' && block.attachment && typeof block.attachment === 'object') {
      const id = block.attachment.attachmentId ?? block.attachment.id
      if (id !== undefined && id !== null && String(id) !== '') {
        into.set(String(id), block.attachment)
      }
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      collectRefsFromContent(block.content, into)
    }
  }
}

/**
 * 一个事件载荷 → 待扫描的 content 列表。四种形态对应宿主日志里图片块的
 * 全部落点：user/message 直挂 data.content；assistant/message 与
 * tool/result 挂 data.message.content；agent/inbox/spliced 挂
 * data.inserted[].content（用户排队上传，未进表面前只有这里能看到）；
 * assistant/chunk 的 block-end 携带完整块。
 */
function contentsOfEvent(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return []
  const out = []
  if (Array.isArray(data.content)) out.push(data.content)
  if (data.message && Array.isArray(data.message.content)) out.push(data.message.content)
  if (Array.isArray(data.inserted)) {
    for (const item of data.inserted) {
      if (item && Array.isArray(item.content)) out.push(item.content)
    }
  }
  if (
    event.type === 'assistant/chunk'
    && data.chunk && data.chunk.type === 'block-end' && data.chunk.block
  ) {
    out.push([data.chunk.block])
  }
  return out
}

/** 原始事件日志访问器：当前世代 snapshotEvents()，rc6–rc.8 兼 events 属性。 */
function sessionEventsOf(session) {
  try {
    if (session && typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return { events, via: 'snapshotEvents' }
    }
  } catch {
    /* 落到旧访问器 */
  }
  try {
    if (session && Array.isArray(session.events)) return { events: session.events, via: 'events' }
  } catch {
    /* 日志不可访问 */
  }
  return undefined
}

/** 扫描会话（事件日志 + 派生消息）里的全部图片引用，诊断信息写入 diag。 */
function collectSessionRefs(session, diag) {
  const found = new Map()
  const viaEvents = sessionEventsOf(session)
  if (viaEvents !== undefined) {
    diag.eventsVia = viaEvents.via
    diag.eventCount = viaEvents.events.length
    for (const event of viaEvents.events) {
      for (const content of contentsOfEvent(event)) collectRefsFromContent(content, found)
    }
  }
  try {
    if (session && typeof session.deriveMessages === 'function') {
      const messages = session.deriveMessages()
      if (Array.isArray(messages)) {
        diag.derivedCount = messages.length
        for (const message of messages) {
          if (message && Array.isArray(message.content)) {
            collectRefsFromContent(message.content, found)
          }
        }
      }
    }
  } catch {
    /* 派生不可用，事件日志结果已足够 */
  }
  return found
}

/** 组装发给识图模型的固定识别要求 + 调用方要求。 */
function buildInstruction(count, prompt, failures) {
  const lines = [
    `你是识图助手。下面按顺序提供 ${count} 张图片（图1…图${count}）。请按以下要求识别：`,
    '1. 客观、具体地描述每张图的关键信息：主体对象、人物与动作、文字内容、界面布局、颜色、数字数据等，按任务需要取舍。',
    '2. 图中出现的文字按原样转录（保留原文语言，不要翻译），并简要注明位置。',
    '3. 多张图片时分别以「图1」「图2」…开头输出；图片之间有关联（对比、前后变化）时，最后补充一段整体比较。',
    '4. 只描述图中真实可见的内容，不臆测、不编造；看不清或不确定的信息明确标注（不确定）。',
    '5. 默认使用中文回答。',
    `调用方的识别要求：${prompt}`,
  ]
  if (failures.length > 0) {
    lines.push(`（另有 ${failures.length} 张图片读取失败，未能提供：${failures.join('；')}）`)
  }
  return lines.join('\n')
}

/** 从 llm.stream 的分块协议里拼出完整回答文本。 */
async function drainStream(stream, provider, model) {
  let text = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind
      if (kind === 'error' || kind === 'aborted') {
        const failure =
          chunk.reason && chunk.reason.failure && chunk.reason.failure.message
            ? chunk.reason.failure.message
            : String(kind)
        throw new Error(`识图模型 ${provider}/${model} 调用失败：${failure}`)
      }
    }
  }
  return text
}

/**
 * 深度改写消息内容里的图片块（含 tool-result 嵌套，宿主文本适配器会下钻
 * 嵌套内容拒绝图片，只改顶层会让带图工具结果的历史永远无法过审）。
 * 移植自 dsh-vision-router 同名函数：replace(block) 返回块/块数组/null（删除）。
 */
export function rewriteImagesDeep(content, replace) {
  if (!Array.isArray(content)) return { content, changed: false }
  let changed = false
  const next = []
  for (const block of content) {
    if (block && block.type === 'image') {
      changed = true
      const out = replace(block)
      if (out !== undefined && out !== null) {
        if (Array.isArray(out)) next.push(...out)
        else next.push(out)
      }
      continue
    }
    if (block && Array.isArray(block.content)) {
      const inner = rewriteImagesDeep(block.content, replace)
      if (inner.changed) {
        changed = true
        next.push({ ...block, content: inner.content })
        continue
      }
    }
    next.push(block)
  }
  return { content: changed ? next : content, changed }
}

/** 生成「+ 识图」孪生路由的图片标记文本（指引模型调用 recognize_images）。 */
export function imageMarkerText(block) {
  const attachment = (block && block.attachment) || {}
  const id = attachment.attachmentId || attachment.id || 'unknown'
  const name = attachment.name || '图片'
  return (
    `[已收到图片「${name}」（附件 id：「${id}」）。当前模型无法直接查看图片内容；` +
    `需要看图时，调用 recognize_images 工具：images 传 ["${id}"]（可一次传多张图的附件 id；` +
    '也接受该 id 前 8 位起的十六进制短摘要，须唯一匹配），' +
    'prompt 写明具体识别要求（想从图中了解什么）。工具会把图片转发给识图模型并返回识别结果。' +
    '若工具返回"识图模型尚未配置"，请提醒用户到 设置 → 识图模型 选择识图模型后重试。]'
  )
}

export const inject = ['tools', 'llm']

export function apply(ctx, config = {}) {
  // ── 设置（0.1.7 架构）：命名空间由条目 Config 自动派生，浏览器半边经
  //    configForms 写入 profile patch override；这里只声明「不生成自动页」
  //    ——本插件有自己的「识图模型」设置页，官方 custom-page 插件
  //    （ui-chat/ui-theme/llm-deepseek 等）同款 configure({auto:false})。──
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(
      () => sctx.settings.configure({ auto: false }, ctx.fiber),
      'dsh-vision-tool: settings presentation (auto:false)',
    )
  })

  // 配置实时读取：volatile 字段在 apply 里是 ref，官方范式（agent-default-
  // model / bash-local）是**调用时**现读 .get()——原位更新、不重挂。helper
  // 同时容忍 plain 值（settings 缺席时的组合行 config、自测注入的对象）。
  const readConfigValue = (field) => {
    const value = config !== null && typeof config === 'object' ? config[field] : undefined
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
      try {
        return value.get()
      } catch {
        return undefined
      }
    }
    return value
  }
  /** 当前识图模型选择（每次调用现读，设置页写入后立即生效）。 */
  const readSelection = () => {
    const provider = readConfigValue('visionProvider')
    const model = readConfigValue('visionModel')
    return {
      visionProvider: typeof provider === 'string' ? provider : '',
      visionModel: typeof model === 'string' ? model : '',
    }
  }
  /** 「+ 识图」孪生开关记录（缺省/畸形 = 空记录 = 全关）。 */
  const readTwinEnabled = () => {
    const record = readConfigValue('twinEnabled')
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : {}
  }

  // ── 「+ 识图」孪生路由（dsh-vision-router 的 wrappedProviders 机制简化版）──
  //
  // 宿主在发送前按模型目录的 inputModalities 做图片准入：文本模型（如
  // GLM-5.2）带图直接被拦（“当前模型不支持图片”）。这里为每个已注册
  // provider 注册孪生路由「<provider>-vision」：目录镜像原模型但声明
  // inputModalities: ['text','image']，用户在聊天页选择带「+ 识图」的
  // 模型即可发图；真正调模型时把图片块（含 tool-result 嵌套）改写成
  // 文本标记（附件 id + 调用 recognize_images 的指引），再原样委托给
  // 原始 provider —— 图片从不进入语言模型，由语言模型经工具转发给
  // 识图模型。会话日志保留原图，Web UI 照常显示。
  //
  // 孪生完全由公开服务方法构成（listProviders / listModels /
  // resolveModelInfo / providerRetryPolicy / llm.stream 委托），不触碰
  // 适配器注册表内部。provider 可能随设置文档晚于本插件注册，因此在
  // llm/adapters-updated 上响应式同步（自身注册触发的事件幂等收敛）。
  const TWIN_SUFFIX = '-vision'
  const twinHandles = new Map() // 原始 provider -> AdapterRegistrationHandle
  // 宿主会在多步轮的后续步骤丢弃 reasoningEffort（仅首步思考）。
  // 流边界没有会话 id，按 委托provider+model 记住最近一次显式档位并在
  // 后续无档位调用时回注（vision-router issue #103 同款）。
  const lastReasoningEffort = new Map()

  const makeTwinAdapter = (provider) => {
    const twinRoute = provider + TWIN_SUFFIX
    // 孪生模型元数据：原始 provider 的解析结果 + 可收图声明。
    const resolveTwinModel = async (model, signal) => {
      const base = await ctx.llm.resolveModelInfo(provider, model, signal)
      return { ...base, provider: twinRoute, inputModalities: ['text', 'image'] }
    }
    // 改写 + 委托生成器：当前世代运行时总是经 adapter.prepareCall() 取
    // {model, stream} 再派发（stream() 是基类默认路径），两条路共用此实现。
    const twinStream = async function* (options) {
      const rewritten = (options.messages ?? []).map((message) => {
        if (!message || !Array.isArray(message.content)) return message
        const result = rewriteImagesDeep(message.content, (block) => [
          { type: 'text', text: imageMarkerText(block) },
        ])
        return result.changed ? { ...message, content: result.content } : message
      })
      const effortKey = `${provider}\u0000${options.model ?? ''}`
      let effort =
        typeof options.reasoningEffort === 'string' && options.reasoningEffort !== ''
          ? options.reasoningEffort
          : undefined
      if (effort !== undefined) {
        lastReasoningEffort.set(effortKey, effort)
      } else {
        effort = lastReasoningEffort.get(effortKey)
      }
      // 委托给原始 provider 的服务路由（不会递归回孪生自身）。
      yield* ctx.llm.stream({
        ...(effort === undefined ? options : { ...options, reasoningEffort: effort }),
        provider,
        messages: rewritten,
      })
    }
    return {
      providerInfo() {
        let name = provider
        try {
          const hit = ctx.llm.listProviders().find((entry) => entry && entry.id === provider)
          if (hit && typeof hit.name === 'string' && hit.name !== '') name = hit.name
        } catch {
          /* 展示名降级为 provider id */
        }
        return { id: twinRoute, name: `${name} + 识图` }
      },
      providerRetryPolicy() {
        try {
          return ctx.llm.providerRetryPolicy(provider)
        } catch {
          return undefined
        }
      },
      // 图片请求定价也委托原始 provider（运行时按注册直呼此方法，
      // 缺失会在带图请求的计价查询上抛 TypeError）。
      imageRequestPricing(_provider, model) {
        try {
          return ctx.llm.imageRequestPricing(provider, model)
        } catch {
          return undefined
        }
      },
      async listModels() {
        try {
          const enabled = readTwinEnabled()
          const listed = await ctx.llm.listModels(provider)
          return (listed ?? [])
            // 孪生开关只放行被打开的模型：关闭的模型不出现在「+ 识图」分组里；
            // 整个 provider 全关 → 空数组 → 目录丢弃空组 → 孪生整条消失。
            .filter((model) => model !== null && typeof model === 'object'
              && enabled[encodeTwinKey(provider, model.id)] === true)
            .map((model) => ({
              ...model,
              provider: twinRoute,
              inputModalities: ['text', 'image'],
            }))
        } catch {
          return []
        }
      },
      resolveModel: (_provider, model, signal) => resolveTwinModel(model, signal),
      prepareCall: async (_provider, model, signal) => ({
        model: await resolveTwinModel(model, signal),
        stream: twinStream,
      }),
      stream: twinStream,
    }
  }

  const syncTwins = () => {
    const wanted = new Set()
    try {
      for (const entry of ctx.llm.listProviders()) {
        const id = entry && typeof entry.id === 'string' ? entry.id : ''
        // 跳过孪生路由自身（含其他插件的 *-vision 包装路由）。
        if (id === '' || id.endsWith(TWIN_SUFFIX)) continue
        wanted.add(id)
      }
    } catch {
      /* 目录不可用时保持现有孪生不变 */
    }
    for (const [provider, handle] of [...twinHandles]) {
      if (!wanted.has(provider)) {
        try {
          handle()
        } catch {
          /* 卸载失败由框架fiber清理兜底 */
        }
        twinHandles.delete(provider)
      } else {
        wanted.delete(provider)
      }
    }
    for (const provider of wanted) {
      const twinRoute = provider + TWIN_SUFFIX
      try {
        const handle = ctx.llm.registerAdapter([twinRoute], makeTwinAdapter(provider))
        ctx.effect(() => handle, `dsh-vision-tool: twin route ${twinRoute}`)
        twinHandles.set(provider, handle)
        ctx.logger?.info?.('dsh-vision-tool: registered twin route %s', twinRoute)
      } catch (error) {
        ctx.logger?.warn?.(
          'dsh-vision-tool: twin route %s registration failed: %s',
          twinRoute,
          error && error.message ? error.message : String(error),
        )
      }
    }
  }
  syncTwins()
  ctx.effect(
    () => ctx.on('llm/adapters-updated', syncTwins),
    'dsh-vision-tool: twin sync on adapters-updated',
  )

  // ── 会话工具门控：非「+ 识图」孪生会话不把 recognize_images 载入上下文 ──
  //
  // 发给模型的 tools = assembly.tools，在 systemPrompt.assemble（agent.ts，
  // 先于 agent/pre-step）内由全局工具 provider 按作用域可见性算出；而
  // installModelSelection 也在同一次 assemble 里采样该步待用的模型。因此在这里
  // 的 system-prompt/assemble 权威瀑布（返回值即最终 assembly）按「该步将用的
  // 模型是否孪生」过滤，与模型解析同边界、零时序竞态——比 tools.restrict 更稳，
  // 后者须在 assemble 之前就位、模型切换步会错一拍。
  //
  // 模型读取链与宿主 selection 一致：投影 pending ?? lastUsed（selectModel 与
  // selection.current 同时置位、消费后由 request/header 清除）→ requestHeader →
  // agentDefaultModel。任一层缺席/未知则 fail-open（保留工具）——误藏孪生所需
  // 工具会打断看图链路，多留一个未用工具无害。
  const isTwinRoute = (provider) => typeof provider === 'string' && provider.endsWith('-vision')
  const resolveSelectionProvider = (agent) => {
    if (agent === undefined || agent === null) return undefined
    try {
      const projections = ctx.get('sessionProjections')
      const session = agent.session
      if (projections !== undefined && projections !== null
        && session !== undefined && session !== null
        && typeof projections.stateOf === 'function') {
        const state = projections.stateOf(session, 'modelSelection')
        const selected = state !== undefined && state !== null
          ? (state.pending ?? state.lastUsed)
          : undefined
        if (selected !== undefined && selected !== null
          && typeof selected.provider === 'string' && selected.provider !== '') {
          return selected.provider
        }
      }
    } catch { /* 投影不可用，落到下一层 */ }
    try {
      const session = agent.session
      const header = session !== undefined && session !== null
        && typeof session.requestHeader === 'function'
        ? session.requestHeader()
        : undefined
      const provider = header !== undefined && header !== null && header.config !== undefined
        ? header.config.provider
        : undefined
      if (typeof provider === 'string' && provider !== '') return provider
    } catch { /* 请求头不可用，落到下一层 */ }
    try {
      const fallback = ctx.get('agentDefaultModel')
      const selection = fallback !== undefined && fallback !== null
        && typeof fallback.currentSelection === 'function'
        ? fallback.currentSelection()
        : undefined
      if (selection !== undefined && selection !== null
        && typeof selection.provider === 'string' && selection.provider !== '') {
        return selection.provider
      }
    } catch { /* 默认模型不可用 */ }
    return undefined
  }
  // 隐藏 iff 模型已知且非孪生。
  const shouldHideRecognizeImages = (agent) => {
    const provider = resolveSelectionProvider(agent)
    return provider !== undefined && !isTwinRoute(provider)
  }
  ctx.effect(
    () =>
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const result = await next()
        const agent = context !== undefined && context !== null ? context.agent : undefined
        if (!shouldHideRecognizeImages(agent)) return result
        const tools = Array.isArray(result.tools) ? result.tools : []
        return { ...result, tools: tools.filter((entry) => entry.name !== TOOL_NAME) }
      }),
    'dsh-vision-tool: recognize_images visibility gate',
  )

  // ── 附件引用索引：agent/pre-step 每步送达 claimed 消息（主路径 ①）──────
  //
  // waterfall 监听器必须调用 next() 并返回其结果；索引动作全部包裹在
  // try/catch 里，绝不影响步进决策。
  const refsByAgent = new WeakMap() // Agent -> Map(attachmentId -> ref)
  const recentRefs = new Map() // 有界 LRU：attachmentId -> ref（最近使用序）
  const touchRef = (map, id, ref) => {
    map.delete(id)
    map.set(id, ref)
    if (map === recentRefs && map.size > RECENT_REF_LIMIT) {
      map.delete(map.keys().next().value)
    }
  }
  const recordRefs = (agent, contents) => {
    const batch = new Map()
    for (const content of contents) collectRefsFromContent(content, batch)
    if (batch.size === 0) return
    const keyed = agent !== undefined && agent !== null && typeof agent === 'object'
    let per = keyed ? refsByAgent.get(agent) : undefined
    if (keyed && per === undefined) {
      per = new Map()
      refsByAgent.set(agent, per)
    }
    for (const [id, ref] of batch) {
      if (per !== undefined) touchRef(per, id, ref)
      touchRef(recentRefs, id, ref)
    }
  }
  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (payload, next) => {
        try {
          const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
          recordRefs(
            payload ? payload.agent : undefined,
            messages.map((message) =>
              message && Array.isArray(message.content) ? message.content : [],
            ),
          )
        } catch {
          /* 索引失败不阻断步进 */
        }
        return next()
      }),
    'dsh-vision-tool: agent/pre-step attachment index',
  )

  /**
   * 附件 ID → {ref, diag}：① pre-step 索引（按 agent / 全局 LRU）→
   * ② 会话日志四形态扫描。全空时 diag 携带诊断数据供报错用。
   */
  const resolveAttachmentRef = (agent, session, id) => {
    const wanted = String(id).trim()
    const diag = {
      hasAgent: agent !== undefined && agent !== null,
      hasSession: session !== undefined && session !== null,
    }
    const per = agent !== undefined && agent !== null ? refsByAgent.get(agent) : undefined
    if (per !== undefined) {
      const hit = per.get(wanted)
      if (hit !== undefined) return { ref: hit, diag }
    }
    const recent = recentRefs.get(wanted)
    if (recent !== undefined) return { ref: recent, diag }
    const sessionRefs = collectSessionRefs(session, diag)
    // 扫描副产品顺手入全局 LRU，后续调用免扫。
    for (const [found, ref] of sessionRefs) touchRef(recentRefs, found, ref)
    diag.sessionRefIds = [...sessionRefs.keys()]
    const hit = sessionRefs.get(wanted)
    if (hit !== undefined) return { ref: hit, diag }
    return { ref: undefined, diag }
  }

  /**
   * 附件短摘要 → {ref, candidates, diag}：小写化前缀在 ① per-agent pre-step
   * 索引 ② 全局 LRU ③ 会话日志扫描三层里做唯一匹配（候选按 id 去重；扫描
   * 结果顺手回填 LRU）。恰 1 个命中返回 ref；0/多个命中返回候选完整 ID 列
   * 表，供调用方组装可自纠的报错。完整 ID 是自身的最长前缀，因此该函数
   * 天然覆盖精确查找。
   */
  const resolveAttachmentRefByPrefix = (agent, session, prefix) => {
    const wanted = prefix.toLowerCase()
    const diag = {
      hasAgent: agent !== undefined && agent !== null,
      hasSession: session !== undefined && session !== null,
    }
    const matches = new Map() // 小写化完整 id -> ref
    const consider = (map) => {
      if (map === undefined) return
      for (const [id, ref] of map) {
        if (id.toLowerCase().startsWith(wanted)) matches.set(id.toLowerCase(), ref)
      }
    }
    consider(agent !== undefined && agent !== null ? refsByAgent.get(agent) : undefined)
    consider(recentRefs)
    const sessionRefs = collectSessionRefs(session, diag)
    // 扫描副产品顺手入全局 LRU，与精确查找同款。
    for (const [found, ref] of sessionRefs) touchRef(recentRefs, found, ref)
    diag.sessionRefIds = [...sessionRefs.keys()]
    consider(sessionRefs)
    if (matches.size === 1) {
      return { ref: matches.values().next().value, candidates: [], diag }
    }
    return { ref: undefined, candidates: [...matches.keys()], diag }
  }

  const describeDiag = (diag) => {
    const parts = [`exec.agent=${diag.hasAgent ? '有' : '无'}`, `session=${diag.hasSession ? '有' : '无'}`]
    if (diag.eventsVia !== undefined) parts.push(`${diag.eventsVia} 日志 ${diag.eventCount} 个事件`)
    if (diag.derivedCount !== undefined) parts.push(`派生消息 ${diag.derivedCount} 条`)
    if (diag.sessionRefIds !== undefined) {
      parts.push(
        diag.sessionRefIds.length > 0
          ? `扫到图片附件 ${diag.sessionRefIds.length} 个（${diag.sessionRefIds
              .slice(0, 3)
              // 完整 ID 而非截断展示：调用方（模型）要靠这份清单一步自纠，
              // 截断形式无法直接回传（短摘要虽可用，但完整 ID 最不易错）。
              .map((x) => x)
              .join('、')}${diag.sessionRefIds.length > 3 ? '…' : ''}）`
          : '会话里未扫到任何图片附件',
      )
    }
    parts.push(`pre-step 索引 ${recentRefs.size} 条`)
    return parts.join('，')
  }

  // ── 图片输入 → ImageAttachmentRef（附件 ID 走三层解析；文件路径经 ─────
  //    fs 读取 + attachments.saveImage 落成持久引用，适配器自行取字节）──
  const resolveImageBlock = async (exec, input) => {
    const raw = String(input ?? '').trim()
    if (raw === '') throw new Error('空的图片引用')
    if (SHA256_FORM_RE.test(raw)) {
      const agent = exec && typeof exec.agent === 'object' ? exec.agent : undefined
      const session =
        agent && agent.session !== undefined && agent.session !== null
          ? agent.session
          : exec && exec.session !== undefined && exec.session !== null
            ? exec.session
            : undefined
      const { ref, candidates, diag } = resolveAttachmentRefByPrefix(agent, session, raw)
      if (ref !== undefined) {
        return { type: 'image', attachment: ref }
      }
      if (candidates.length > 1) {
        throw new Error(
          `附件短摘要 "${raw}" 匹配到多个附件：${candidates.join('、')}；` +
          '请传更长的前缀或完整附件 ID。',
        )
      }
      throw new Error(
        `未知附件 ID "${raw}"（未找到以该摘要为前缀的附件，必须是本会话中上传过的图片）。` +
        `诊断：${describeDiag(diag)}`,
      )
    }
    if (ATTACHMENT_ID_RE.test(raw)) {
      const agent = exec && typeof exec.agent === 'object' ? exec.agent : undefined
      const session =
        agent && agent.session !== undefined && agent.session !== null
          ? agent.session
          : exec && exec.session !== undefined && exec.session !== null
            ? exec.session
            : undefined
      const { ref, diag } = resolveAttachmentRef(agent, session, raw)
      if (ref === undefined) {
        throw new Error(`未知附件 ID "${raw}"（必须是本会话中上传过的图片）。诊断：${describeDiag(diag)}`)
      }
      return { type: 'image', attachment: ref }
    }
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('fs 服务不可用，无法读取文件路径')
    const target = await fs.resolve(raw)
    const bytes = await fs.readBytes(target, exec?.signal, MAX_IMAGE_BYTES)
    const mediaType = sniffMediaType(bytes) ?? mediaTypeOf(raw)
    if (mediaType === undefined) {
      throw new Error('不支持的图片格式（仅 png/jpeg/webp/gif）')
    }
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('attachments 服务不可用')
    const ref = await attachments.saveImage({ data: bytes, mediaType })
    return { type: 'image', attachment: ref }
  }

  // ── 识图工具 ────────────────────────────────────────────────────────────
  const stringOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
        description:
          '把一张或多张图片转发给配置好的识图模型进行识别，返回识别结果。images 接受三种形态：' +
          '① 本会话上传图片的完整附件 ID（"sha256:" + 64 位十六进制）；② 该 ID 的十六进制短摘要' +
          '（前 ≥8 位，如 "sha256:a5303c40"，纯文本模型收到的图片占位文本即为此形态，唯一前缀匹配即可）；' +
          '③ 本地图片文件路径（png/jpeg/webp/gif）。一次最多 10 张；' +
          'prompt 给出具体的识别要求（想问什么、关注什么），留空则做通用描述。' +
          '识图模型需先在网页「设置 → 识图模型」中选择。',
        parameters: {
          type: 'object',
          properties: {
            images: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: MAX_IMAGES,
              description:
                '图片引用列表：完整附件 ID（"sha256:" + 64 位十六进制）、该 ID 的十六进制短摘要（前 ≥8 位，唯一前缀匹配），或本地图片文件路径（工作区相对/绝对）',
            },
            prompt: {
              type: 'string',
              description: '识别要求：想从图片中了解什么。留空则对图片做通用描述',
            },
          },
          required: ['images'],
          additionalProperties: false,
        },
        output: stringOutput,
        timeoutMs: 240000,
        async execute(args, exec) {
          const images = Array.isArray(args.images) ? args.images.map((item) => String(item)) : []
          if (images.length === 0) {
            return `${TOOL_NAME}: images 参数为空。请传入 ${MAX_IMAGES} 张以内的图片附件 ID（如 "sha256:..."）或图片文件路径。`
          }
          if (images.length > MAX_IMAGES) {
            return `${TOOL_NAME}: 一次最多 ${MAX_IMAGES} 张图片，收到 ${images.length} 张，请分批调用。`
          }
          const { visionProvider, visionModel } = readSelection()
          if (visionProvider === '' || visionModel === '') {
            return (
              '识图模型尚未配置：请在网页「设置 → 识图模型」页的下拉列表里选择一个模型' +
              '（来源为「设置 → 模型」中已配置的模型），保存后重试本次调用。'
            )
          }
          if (visionProvider.endsWith(TWIN_SUFFIX)) {
            return (
              `识图模型不能是「${visionProvider}」——那是给聊天模型发图用的「+ 识图」包装入口，` +
              '不是真正的视觉后端。请在 设置 → 识图模型 选择一个真实模型（如 GLM-4.6V / Qwen-VL 等视觉模型）。'
            )
          }
          // 目录声明纯文本的模型做不了识图后端：提前拦截，避免静默产出
          // 无图回答（宿主服务会把发给文本模型的图片块剔除）。
          try {
            const info = await ctx.llm.resolveModelInfo(visionProvider, visionModel)
            if (info && Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
              return (
                `识图模型 ${visionProvider}/${visionModel} 不支持图片输入（inputModalities: ${info.inputModalities.join(',')}），` +
                '请在 设置 → 识图模型 选择一个视觉模型（目录声明可收图的）。'
              )
            }
          } catch {
            /* 目录解析失败时交给实际调用报错 */
          }

          const blocks = []
          const failures = []
          for (let i = 0; i < images.length; i++) {
            try {
              blocks.push(await resolveImageBlock(exec, images[i]))
            } catch (error) {
              failures.push(`图${i + 1}（${images[i]}）：${error?.message ?? String(error)}`)
            }
          }
          if (blocks.length === 0) {
            return `${TOOL_NAME}: 所有图片都未能读取——${failures.join('；')}`
          }

          const prompt =
            typeof args.prompt === 'string' && args.prompt.trim() !== ''
              ? args.prompt.trim()
              : '对这些图片的内容做通用描述。'
          const instruction = buildInstruction(images.length, prompt, failures)
          const messages = [
            { role: 'user', content: [{ type: 'text', text: instruction }, ...blocks] },
          ]

          let text
          try {
            text = await drainStream(
              ctx.llm.stream({
                provider: visionProvider,
                model: visionModel,
                messages,
                maxTokens: 4096,
                signal: exec?.signal,
              }),
              visionProvider,
              visionModel,
            )
          } catch (error) {
            return `${TOOL_NAME}: ${error?.message ?? String(error)}`
          }
          if (text.trim() === '') {
            return `${TOOL_NAME}: 识图模型 ${visionProvider}/${visionModel} 返回了空结果。`
          }
          return text
        },
      }),
    'dsh-vision-tool: recognize_images tool',
  )

  // ── 清理端点（设置页按钮 → 同源 POST）──────────────────────────────────
  //
  // 静态挂载插件没有 host.call 通道（那是动态 Cordis 插件体系的），借用
  // 宿主 webServer 服务的命名路由：浏览器半边同源 fetch 命中即执行清理。
  // 守卫用上方「路由信任围栏」（官方 /api 语义）：桌面壳经 Electron 主进程
  // 转发的请求没有 Origin 头（forwardWebRequest 显式删除 host/origin/
  // sec-fetch-site），因此不能要求 Origin 必须存在——0.1.x 的字面同源检查
  // 正是这样在桌面 GUI 里 403（cross-origin request rejected）。围栏同时
  // 拒绝跨站标记与非回环 Host（DNS-rebinding 防御），0.0.0.0 部署经
  // lanDeployment 保持局域网同源可用。
  //
  // 注册必须走 ctx.inject 回调而非 apply 时的 ctx.get：本插件行可能在
  // webServer 服务激活前进店（一次性 get 扑空 → 路由缺席 → POST 落进
  // client-modules 的 /plugins 前缀路由被 405）。回调形式在服务就绪时
  // 注册、被替换时自动重挂；无 webServer 的部署回调不跑，其余功能不受
  // 影响。
  //
  // 归档集读取 workspaceRegistry 服务（请求时现读，保证拿到最新归档状态）；
  // 服务缺席/未就绪/读取异常都按空集处理——归档排除是「多删」开关，缺省
  // 关闭落在安全侧（保留更多）。
  ctx.inject(['webServer'], (webCtx) => {
    const lanDeployment = webCtx.webServer?.host === '0.0.0.0'
    const readArchivedIds = () => {
      try {
        const registry = webCtx.get('workspaceRegistry')
        const archived = registry && registry.archivedSessionIds
        if (!Array.isArray(archived)) return new Set()
        return new Set(archived.map(String))
      } catch {
        return new Set()
      }
    }
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-vision-tool/cleanup-attachments',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(payload))
            }
            try {
              if (req.method !== 'POST') {
                send(405, { ok: false, error: 'method not allowed' })
                return
              }
              if (!isTrustedPluginRequest(req, lanDeployment)) {
                send(403, { ok: false, error: 'untrusted request rejected' })
                return
              }
              const result = await cleanupAttachments({ archivedIds: readArchivedIds() })
              webCtx.logger?.info?.('dsh-vision-tool: attachment cleanup done (%j)', result)
              send(200, { ok: true, ...result })
            } catch (error) {
              send(500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'dsh-vision-tool: cleanup-attachments route',
    )
  })
}
