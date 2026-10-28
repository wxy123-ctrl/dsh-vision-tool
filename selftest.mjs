// selftest.mjs — dsh-vision-tool host-half smoke test.
// Mocks mirror the live service contracts read from the running host
// (tools.register / llm registerAdapter+catalog+stream chunk protocol /
// settings.configure({auto:false}) + volatile config 调用时实时读 /
// attachments.saveImage / fs.resolve+readBytes /
// agent/pre-step waterfall / session event-log scan / ctx.on event bus /
// webServer.register named route).
// Run: node selftest.mjs

import assert from 'node:assert/strict'
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const pluginUrl = new URL('./index.js', import.meta.url).href
const plugin = await import(pluginUrl)

// ── 嗅探分支只需要合法的 png 魔数前缀（mock 链路不解码图像本体）。 ────────
const PNG_1PX = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 0x11)])

// ── mock services ────────────────────────────────────────────────────────
const registeredTools = new Map()
const savedImages = []
let llmStreamCalls = []

function makeCtx({
  settingsPresent = true,
  storedConfig = {},
  webServer = undefined,
  workspaceRegistry = undefined,
  sessionProjections = undefined,
  agentDefaultModel = undefined,
} = {}) {
  // 活配置对象：apply 持有同一对象、__save 原位变异——模拟 0.1.7 volatile
  // ref 语义（设置写入不重挂 apply，调用时 .get() 现读即得新值）。
  const liveConfig = { ...storedConfig }
  const settingsCalls = []

  // 事件总线（llm/adapters-updated 等）
  const listeners = new Map()
  const on = (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(cb)
    return () => listeners.get(event).delete(cb)
  }
  const emit = (event) => {
    for (const cb of listeners.get(event) ?? []) cb()
  }
  // waterfall 事件派发（单监听器）：返回 {out, nextCalled}
  const emitEvent = async (event, payload) => {
    const cbs = [...(listeners.get(event) ?? [])]
    assert.equal(cbs.length, 1, `exactly one ${event} listener`)
    let nextResult
    const next = async () => {
      nextResult = { kind: 'enter', marker: true }
      return nextResult
    }
    const out = await cbs[0](payload, next)
    return { out, nextCalled: nextResult !== undefined }
  }
  // system-prompt/assemble 权威瀑布派发（三参：assembly, context, next）。
  // next() 返回基线 assembly（即入参），模拟核心工具 provider 已收集好的产物。
  const emitAssemble = async (assembly, context) => {
    const cbs = [...(listeners.get('system-prompt/assemble') ?? [])]
    assert.equal(cbs.length, 1, 'exactly one system-prompt/assemble listener')
    const next = async () => assembly
    return await cbs[0](assembly, context, next)
  }

  // llm 目录状态（孪生路由测试用）
  const llmState = {
    providers: [], // [{id, name}]
    models: {}, // provider -> [{id, name, inputModalities?}]
    adapters: new Map(), // route -> adapter（孪生注册表）
  }

  // 0.1.7 settings 服务只暴露 configure（register/scope/watch 已随旧架构
  // 移除——describe 命名空间由条目 Config 的 volatile 字段自动派生）。
  const settingsService = {
    configure(presentation, owner) {
      assert.equal(presentation.auto, false, 'custom settings page must suppress the auto form page')
      assert.equal(owner, ctx.fiber, 'configure names the owning fiber')
      settingsCalls.push({ presentation, owner })
      return () => {}
    },
  }

  const ctx = {
    fiber: { name: 'vision-tool-test-fiber' },
    tools: {
      register(def) {
        registeredTools.set(def.name, def)
        return () => registeredTools.delete(def.name)
      },
    },
    llm: {
      registerAdapter(routes, adapter) {
        for (const route of routes) llmState.adapters.set(route, adapter)
        return () => {
          for (const route of routes) llmState.adapters.delete(route)
        }
      },
      listProviders() {
        return llmState.providers.slice()
      },
      async listModels(provider) {
        return (llmState.models[provider] ?? []).map((m) => ({ ...m, provider }))
      },
      async resolveModelInfo(provider, model) {
        const hit = (llmState.models[provider] ?? []).find((m) => m.id === model)
        if (hit === undefined) throw new Error(`unknown model ${provider}/${model}`)
        return { ...hit, provider, id: model }
      },
      providerRetryPolicy() {
        return undefined
      },
      imageRequestPricing(provider, model) {
        return { provider, model, mocked: true }
      },
      stream(options) {
        llmStreamCalls.push(options)
        const text = '图1：一张 1x1 的透明 PNG 测试图。'
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'sessionProjections') return sessionProjections
      if (name === 'agentDefaultModel') return agentDefaultModel
      if (name === 'fs') {
        return {
          async resolve(p) {
            return { target: p }
          },
          async readBytes(target, signal, maxBytes) {
            assert.equal(maxBytes, 20 * 1024 * 1024)
            return PNG_1PX
          },
        }
      }
      if (name === 'attachments') {
        return {
          async saveImage({ data, mediaType }) {
            const ref = { attachmentId: `sha256:${Buffer.from(data).toString('hex').slice(0, 64)}`, mediaType }
            savedImages.push(ref)
            return ref
          },
          async readImage(ref) {
            return { data: PNG_1PX, ref }
          },
        }
      }
      return undefined
    },
    inject(deps, cb) {
      if (deps.length === 1 && deps[0] === 'settings') {
        // 真实语义：settings 服务缺席时回调挂起（永不调用），而非抛错。
        if (settingsPresent) cb({ settings: settingsService, effect(fn, label) { return fn() } })
        return
      }
      if (deps.length === 1 && deps[0] === 'webServer') {
        // 真实语义：webServer 服务就绪时回调立即执行（声明注入暴露为
        // webCtx.webServer），缺席时挂起。回调 ctx 复用本 mock 的 get，
        // 路由处理器里的 readArchivedIds() 才能读到 workspaceRegistry。
        if (webServer !== undefined) {
          cb({ get: (n) => ctx.get(n), webServer, effect(fn, label) { return fn() } })
        }
        return
      }
      throw new Error(`unexpected inject ${deps.join(',')}`)
    },
    effect(fn, _label) {
      return fn()
    },
    on,
  }
  // 测试钩子
  ctx.__config = liveConfig
  ctx.__settingsCalls = settingsCalls
  ctx.__save = async (patch) => {
    Object.assign(liveConfig, patch)
  }
  ctx.__llm = llmState
  ctx.__emit = emit
  ctx.__emitEvent = emitEvent
  ctx.__emitAssemble = emitAssemble
  return ctx
}

const drain = async (stream) => {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

// ── 1. apply 注册了工具 ──────────────────────────────────────────────────
{
  registeredTools.clear()
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  assert.equal(registeredTools.size, 1, 'exactly one tool registered')
  assert.equal(ctx.__settingsCalls.length, 1, 'settings.configure called once (auto page suppressed)')
  assert.equal(ctx.__settingsCalls[0].owner, ctx.fiber, 'configure names this plugin fiber')
  const tool = registeredTools.get('recognize_images')
  assert.ok(tool, 'recognize_images registered')
  assert.equal(typeof tool.execute, 'function')
  assert.deepEqual(tool.parameters.required, ['images'])
  assert.equal(tool.timeoutMs, 240000)
  console.log('1. apply + tool registration OK')
}

// ── 2. 未配置识图模型 → 返回配置指引（不 throw）──────────────────────────
{
  registeredTools.clear()
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  const tool = registeredTools.get('recognize_images')
  const result = await tool.execute(
    { images: ['D:/tmp/a.png'], prompt: '这是什么' },
    { agent: { session: undefined } },
  )
  assert.match(result, /识图模型尚未配置/)
  console.log('2. unconfigured guidance OK')
}

// ── 3. 配置后走文件路径：读字节→嗅探→saveImage→llm.stream（图片块+指令）──
{
  registeredTools.clear()
  llmStreamCalls = []
  savedImages.length = 0
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  await ctx.__save({ visionProvider: 'zhipu', visionModel: 'glm-4.6v' })
  const tool = registeredTools.get('recognize_images')
  const result = await tool.execute(
    { images: ['test/a.png'], prompt: '图里有什么文字' },
    { agent: { session: undefined }, signal: undefined },
  )
  assert.equal(result, '图1：一张 1x1 的透明 PNG 测试图。')
  assert.equal(savedImages.length, 1)
  assert.equal(savedImages[0].mediaType, 'image/png')
  assert.equal(llmStreamCalls.length, 1)
  const call = llmStreamCalls[0]
  assert.equal(call.provider, 'zhipu')
  assert.equal(call.model, 'glm-4.6v')
  assert.equal(call.maxTokens, 4096)
  assert.equal(call.messages.length, 1)
  assert.equal(call.messages[0].role, 'user')
  const content = call.messages[0].content
  assert.equal(content.length, 2, 'one text + one image block')
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /图里有什么文字/)
  assert.match(content[0].text, /识图助手/)
  assert.match(content[0].text, /原样转录/)
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.mediaType, 'image/png')
  console.log('3. file-path flow (sniff→saveImage→stream blocks) OK')
}

// ── 4. 附件 ID：会话日志四形态扫描（三层里的 ②）─────────────────────────
// 覆盖宿主日志里图片块的全部落点：user/message 直挂 content、tool/result
// 经 data.message.content 嵌套 tool-result、agent/inbox/spliced 的
// inserted[]（排队上传，未进表面）、assistant/chunk block-end。
{
  registeredTools.clear()
  llmStreamCalls = []
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  await ctx.__save({ visionProvider: 'p', visionModel: 'm' })
  const tool = registeredTools.get('recognize_images')
  const refA = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' }
  const refB = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/jpeg' }
  const refC = { attachmentId: 'sha256:' + 'c'.repeat(64), mediaType: 'image/webp' }
  const refD = { attachmentId: 'sha256:' + 'd'.repeat(64), mediaType: 'image/gif' }
  const events = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: refA }] } },
    { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: refB }] }] } } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ role: 'user', content: [{ type: 'image', attachment: refC }] }] } },
    { type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { type: 'image', attachment: refD } } } },
  ]

  const runWith = async (session, id) => {
    llmStreamCalls = []
    await tool.execute({ images: [id], prompt: '' }, { agent: { session }, signal: undefined })
    return llmStreamCalls[0].messages[0].content
  }
  // 4a. snapshotEvents()：四种事件形态逐一命中
  let content = await runWith({ snapshotEvents: () => events }, refA.attachmentId)
  assert.equal(content[1].attachment, refA, 'snapshotEvents(): user/message direct content')
  content = await runWith({ snapshotEvents: () => events }, refB.attachmentId)
  assert.equal(content[1].attachment, refB, 'snapshotEvents(): tool/result nested tool-result')
  content = await runWith({ snapshotEvents: () => events }, refC.attachmentId)
  assert.equal(content[1].attachment, refC, 'snapshotEvents(): agent/inbox/spliced inserted[]')
  content = await runWith({ snapshotEvents: () => events }, refD.attachmentId)
  assert.equal(content[1].attachment, refD, 'snapshotEvents(): assistant/chunk block-end')
  // 4b. rc6–rc.8 兼：events 属性
  content = await runWith({ events }, refA.attachmentId)
  assert.equal(content[1].attachment, refA, 'legacy events property')
  // 4c. deriveMessages()（当前世代派生消息，无日志访问器时）
  content = await runWith(
    { deriveMessages: () => events.map((e) => e.data.message ?? e.data) },
    refB.attachmentId,
  )
  assert.equal(content[1].attachment, refB, 'deriveMessages(): nested image resolved')

  // 4d. 两张图一次调用（同一访问器）
  llmStreamCalls = []
  await tool.execute(
    { images: [refA.attachmentId, refB.attachmentId], prompt: '' },
    { agent: { session: { snapshotEvents: () => events } }, signal: undefined },
  )
  content = llmStreamCalls[0].messages[0].content
  assert.equal(content.length, 3, 'text + two image blocks in ONE call')
  assert.equal(content[1].attachment, refA, 'attachment id resolved without re-saving')
  assert.equal(content[2].attachment, refB, 'tool-result nested image resolved')
  assert.match(content[0].text, /2 张图片/)
  console.log('4. session-log scan (4 payload shapes + legacy events + deriveMessages) OK')
}

// ── 4b. pre-step 索引：exec 链路失明时（线上故障形态）事件索引兜底 ────────
{
  registeredTools.clear()
  llmStreamCalls = []
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  await ctx.__save({ visionProvider: 'p', visionModel: 'm' })
  const tool = registeredTools.get('recognize_images')
  const ref = { attachmentId: 'sha256:' + 'f'.repeat(64), mediaType: 'image/png' }

  // waterfall 语义：监听器必须调 next() 并原样返回其结果
  const agent = { id: 'agent-1' } // 故意没有 session —— 模拟线上失明的 exec.agent
  const { out, nextCalled } = await ctx.__emitEvent('agent/pre-step', {
    agent,
    messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: ref }] }],
    turn: 1,
    step: 1,
  })
  assert.ok(nextCalled, 'listener calls next()')
  assert.deepEqual(out, { kind: 'enter', marker: true }, 'listener returns next() result')

  // exec.agent 存在但没有 session → pre-step 按 agent 索引命中
  let result = await tool.execute({ images: [ref.attachmentId], prompt: '' }, { agent, signal: undefined })
  assert.equal(result, '图1：一张 1x1 的透明 PNG 测试图。', 'pre-step per-agent index resolves without session')
  // exec 里连 agent 都没有（完全失明）→ 全局 LRU 命中
  llmStreamCalls = []
  await tool.execute({ images: [ref.attachmentId], prompt: '' }, { signal: undefined })
  assert.equal(llmStreamCalls[0].messages[0].content[1].attachment, ref, 'global LRU resolves with a bare exec')
  console.log('4b. agent/pre-step index (waterfall next() + bare-exec fallback) OK')
}

// ── 5. 参数防御：空数组 / 超上限 / 全部读取失败 / 误选孪生路由 ────────────
{
  registeredTools.clear()
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  await ctx.__save({ visionProvider: 'p', visionModel: 'm' })
  const tool = registeredTools.get('recognize_images')
  const empty = await tool.execute({ images: [] }, { agent: { session: undefined } })
  assert.match(empty, /images 参数为空/)
  const tooMany = await tool.execute({ images: Array.from({ length: 11 }, (_, i) => `x${i}.png`) }, { agent: { session: undefined } })
  assert.match(tooMany, /最多 10 张/)
  const unknown = await tool.execute({ images: ['sha256:' + 'c'.repeat(64)] }, { agent: { session: undefined } })
  assert.match(unknown, /所有图片都未能读取/)
  assert.match(unknown, /未知附件 ID/)
  assert.match(unknown, /诊断：/, 'failure carries diagnostics for the next round')
  // 误把「+ 识图」孪生路由选成识图模型 → 明确拒绝
  await ctx.__save({ visionProvider: 'glm-vision', visionModel: 'glm-5.2' })
  const twinRejected = await tool.execute({ images: ['x.png'] }, { agent: { session: undefined } })
  assert.match(twinRejected, /不能是「glm-vision」/)
  console.log('5. argument guards (incl. twin-route rejection) OK')
}

// ── 6. settings 服务缺失时：base config 仍可用（降级不崩）────────────────
{
  registeredTools.clear()
  const ctx = makeCtx({ settingsPresent: false })
  plugin.apply(ctx, { visionProvider: 'base-p', visionModel: 'base-m' })
  assert.equal(ctx.__settingsCalls.length, 0, 'settings-absent → configure callback never runs')
  const tool = registeredTools.get('recognize_images')
  llmStreamCalls = []
  await tool.execute({ images: ['x.png'] }, { agent: { session: undefined }, signal: undefined })
  assert.equal(llmStreamCalls[0].provider, 'base-p', 'composition base flows through without settings service')
  console.log('6. settings-absent fallback (base config) OK')
}

// ── 7. 孪生路由：为每个已注册 provider 注册 <id>-vision，目录声明可收图 ──
{
  registeredTools.clear()
  const ctx = makeCtx()
  ctx.__llm.providers = [
    { id: 'glm', name: '智谱 GLM' },
    { id: 'other' },
    { id: 'evil-vision' }, // 已带 -vision 后缀：不得再包一层
  ]
  ctx.__llm.models = {
    glm: [{ id: 'glm-5.2', name: 'GLM-5.2', inputModalities: ['text'] }],
    other: [{ id: 'other-x', name: 'Other X' }],
  }
  plugin.apply(ctx, ctx.__config)
  assert.ok(ctx.__llm.adapters.has('glm-vision'), 'glm twin registered')
  assert.ok(ctx.__llm.adapters.has('other-vision'), 'other twin registered')
  assert.ok(!ctx.__llm.adapters.has('evil-vision-vision'), '-vision routes are not re-wrapped')
  const twin = ctx.__llm.adapters.get('glm-vision')
  assert.deepEqual(twin.providerInfo(), { id: 'glm-vision', name: '智谱 GLM + 识图' })
  // 孪生默认全关（列表为空）；打开 glm-5.2 的开关后目录才列出它，并声明可收图。
  await ctx.__save({ twinEnabled: { [JSON.stringify(['glm', 'glm-5.2'])]: true } })
  const models = await twin.listModels()
  assert.equal(models.length, 1)
  assert.equal(models[0].provider, 'glm-vision')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'], 'twin declares image input (send gate opens)')
  const resolved = await twin.resolveModel('glm-vision', 'glm-5.2')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.equal(resolved.provider, 'glm-vision')
  // 运行时会直呼的完整适配器面：7 个方法全部存在
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof twin[method], 'function', `adapter method ${method} present`)
  }
  assert.deepEqual(twin.imageRequestPricing('glm-vision', 'glm-5.2'), { provider: 'glm', model: 'glm-5.2', mocked: true }, 'pricing delegates to original provider')
  console.log('7. twin registration + full adapter surface + image-capable catalog OK')
}

// ── 8. 孪生 stream：图片块→文本标记，委托原始 provider（不递归）──────────
// 模拟真实运行时的派发路径：adapter.prepareCall() → adapterCall.stream()。
{
  registeredTools.clear()
  llmStreamCalls = []
  const ctx = makeCtx()
  ctx.__llm.providers = [{ id: 'glm', name: 'GLM' }]
  ctx.__llm.models = { glm: [{ id: 'glm-5.2', name: 'GLM-5.2', inputModalities: ['text'] }] }
  plugin.apply(ctx, ctx.__config)
  const twin = ctx.__llm.adapters.get('glm-vision')

  // 运行时第一入口：prepareCall（此前真实报错 registration.adapter.prepareCall is not a function）
  const prepared = await twin.prepareCall('glm-vision', 'glm-5.2')
  assert.ok(prepared && typeof prepared.stream === 'function', 'prepareCall returns {model, stream}')
  assert.deepEqual(prepared.model.inputModalities, ['text', 'image'])
  assert.equal(prepared.model.provider, 'glm-vision')

  const id = 'sha256:' + 'd'.repeat(64)
  const chunks = await drain(
    prepared.stream({
      provider: 'glm-vision',
      model: 'glm-5.2',
      reasoningEffort: 'high',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '帮我看下这张图' },
            { type: 'image', attachment: { attachmentId: id, name: '截图.png' } },
          ],
        },
      ],
    }),
  )
  assert.ok(chunks.some((c) => c.type === 'finish' && c.reason.kind === 'stop'), 'delegate stream passthrough')
  assert.equal(llmStreamCalls.length, 1)
  const delegated = llmStreamCalls[0]
  assert.equal(delegated.provider, 'glm', 'delegates to ORIGINAL provider (no recursion)')
  assert.equal(delegated.reasoningEffort, 'high')
  const flat = JSON.stringify(delegated.messages)
  assert.ok(!/"type":"image"/.test(flat), 'no image block reaches the text model')
  const marker = delegated.messages[0].content.find((b) => b.type === 'text' && b.text.includes('已收到图片'))
  assert.ok(marker, 'marker text present')
  assert.match(marker.text, new RegExp(id))
  assert.match(marker.text, /recognize_images/)
  // 第二次调用（多步轮后续步骤，无 reasoningEffort）→ 回注最近档位
  await drain(
    prepared.stream({ provider: 'glm-vision', model: 'glm-5.2', messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }] }),
  )
  assert.equal(llmStreamCalls[1].reasoningEffort, 'high', 'effort re-injected on later steps')

  // 基类默认路径 stream() 同样可用且行为一致
  await drain(
    twin.stream({ provider: 'glm-vision', model: 'glm-5.2', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: id } }] }] }),
  )
  assert.equal(llmStreamCalls[2].provider, 'glm')
  assert.ok(!/"type":"image"/.test(JSON.stringify(llmStreamCalls[2].messages)), 'direct stream() path rewrites too')
  console.log('8. twin prepareCall/stream rewrite + delegation + effort memory OK')
}

// ── 9. 深度改写：tool-result 嵌套图片也被替换（历史轮不炸文本适配器）────
{
  const nested = [
    { type: 'text', text: '前情' },
    {
      type: 'tool-result',
      toolCallId: 'c1',
      content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'e'.repeat(64) } }],
    },
  ]
  const result = plugin.rewriteImagesDeep(nested, (block) => [
    { type: 'text', text: plugin.imageMarkerText(block) },
  ])
  assert.ok(result.changed)
  const flat = JSON.stringify(result.content)
  assert.ok(!/"type":"image"/.test(flat), 'nested image replaced')
  assert.match(flat, /tool-result/)
  assert.match(flat, /已收到图片/)
  console.log('9. deep rewrite (nested tool-result images) OK')
}

// ── 10. adapters-updated 响应式同步：晚注册的 provider 也能拿到孪生 ──────
{
  registeredTools.clear()
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  assert.equal(ctx.__llm.adapters.size, 0, 'no providers yet, no twins')
  ctx.__llm.providers = [{ id: 'zhipu', name: '智谱' }]
  ctx.__llm.models = { zhipu: [{ id: 'glm-5.2', inputModalities: ['text'] }] }
  ctx.__emit('llm/adapters-updated')
  assert.ok(ctx.__llm.adapters.has('zhipu-vision'), 'twin synced after adapters-updated')
  // provider 消失 → 孪生撤销
  ctx.__llm.providers = []
  ctx.__emit('llm/adapters-updated')
  assert.ok(!ctx.__llm.adapters.has('zhipu-vision'), 'stale twin withdrawn')
  console.log('10. reactive twin sync on llm/adapters-updated OK')
}

// ── 11. 模态守卫：识图模型目录声明纯文本 → 提前拒绝并给出指引 ────────────
{
  registeredTools.clear()
  llmStreamCalls = []
  const ctx = makeCtx()
  ctx.__llm.providers = [{ id: 'glm', name: 'GLM' }]
  ctx.__llm.models = { glm: [{ id: 'glm-5.2', name: 'GLM-5.2', inputModalities: ['text'] }] }
  plugin.apply(ctx, ctx.__config)
  await ctx.__save({ visionProvider: 'glm', visionModel: 'glm-5.2' })
  const tool = registeredTools.get('recognize_images')
  const result = await tool.execute({ images: ['x.png'] }, { agent: { session: undefined }, signal: undefined })
  assert.match(result, /不支持图片输入/)
  assert.match(result, /glm-5\.2/)
  assert.equal(llmStreamCalls.length, 0, 'no vision call is made for a text-only backend')
  console.log('11. text-only vision-model guard OK')
}

// ── 12. 清理：zstd 逐帧解压 + 引用 id 收集 + 保留/删除判定 + 归档排除 ─────
{
  // decodeSegment：宿主 encodeSegment 的逆（~XXXX 转义 + 安全字符原样）。
  assert.equal(plugin.decodeSegment('session-abc-123'), 'session-abc-123')
  assert.equal(plugin.decodeSegment('a~002Eb'), 'a.b')
  assert.equal(plugin.decodeSegment('x~007Ey'), 'x~y', 'escaped tilde decodes')
  assert.equal(plugin.decodeSegment('D-~9ED1~9A6CAI--'), 'D-黑马AI--', 'CJK code units decode')

  const lineA = JSON.stringify({ type: 'user/message', data: { content: [
    { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` } },
  ] } })
  const lineB = JSON.stringify({ type: 'assistant/message' })
  const compressed = Buffer.concat([
    zstdCompressSync(Buffer.from(lineA + '\n')),
    zstdCompressSync(Buffer.from(lineB + '\n')),
  ])
  const text = plugin.decompressSessionLog(compressed).toString('utf8')
  assert.equal(text, `${lineA}\n${lineB}\n`, 'per-line zstd frames decode in order')
  const ids = new Set()
  plugin.collectReferencedIds(compressed, ids)
  assert.deepEqual([...ids], ['a'.repeat(64)], 'referenced sha256 ids collected')

  // 假 DSH 主目录：A 被 live 会话引用；B 未引用且过期；C 未引用但新鲜；
  // D 只被「已归档会话」引用且过期（应删）；tmp 陈旧残留。
  const home = join(tmpdir(), `dsh-vision-tool-selftest-${Date.now()}`)
  const idA = 'a'.repeat(64)
  const idB = 'b'.repeat(64)
  const idC = 'c'.repeat(64)
  const idD = 'd'.repeat(64)
  const now = Date.now()
  await mkdir(join(home, 'sessions', 'ws', 'session-live'), { recursive: true })
  await writeFile(join(home, 'sessions', 'ws', 'session-live', 'session.jsonl.zstd'), compressed)
  const lineArchived = JSON.stringify({ type: 'user/message', data: { content: [
    { type: 'image', attachment: { attachmentId: `sha256:${idD}` } },
  ] } })
  const compressedArchived = zstdCompressSync(Buffer.from(lineArchived + '\n'))
  await mkdir(join(home, 'sessions', 'ws', 'session-archived'), { recursive: true })
  await writeFile(join(home, 'sessions', 'ws', 'session-archived', 'session.jsonl.zstd'), compressedArchived)
  const objectPath = (id) => join(home, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
  for (const id of [idA, idB, idC, idD]) {
    await mkdir(join(home, 'attachments', 'v1', 'objects', id.slice(0, 2)), { recursive: true })
    await writeFile(objectPath(id), Buffer.alloc(10, 1))
  }
  await mkdir(join(home, 'attachments', 'v1', 'tmp'), { recursive: true })
  await writeFile(join(home, 'attachments', 'v1', 'tmp', 'stale-upload'), Buffer.alloc(4))
  // B/D/tmp 写入时间拨回 1 小时前；C 保持“刚刚写入”。
  const stale = new Date(now - 60 * 60_000)
  await utimes(objectPath(idB), stale, stale)
  await utimes(objectPath(idD), stale, stale)
  await utimes(join(home, 'attachments', 'v1', 'tmp', 'stale-upload'), stale, stale)

  // 不带归档集（旧语义）：D 因被归档会话引用而保留。
  const beforeArchival = await plugin.cleanupAttachments({ home, now })
  assert.equal(beforeArchival.scannedSessions, 2)
  assert.equal(beforeArchival.skippedArchivedSessions, 0)
  assert.equal(beforeArchival.removedCount, 1, 'without the archive set: B only')
  const fs = await import('node:fs/promises')
  await fs.stat(objectPath(idD))

  // 带归档集：归档会话日志整卷跳过，其引用不再构成保留理由。
  const result = await plugin.cleanupAttachments({ home, archivedIds: new Set(['session-archived']), now })
  assert.equal(result.scannedSessions, 1, 'archived session log is skipped, not scanned')
  assert.equal(result.skippedArchivedSessions, 1)
  assert.equal(result.referencedCount, 1)
  assert.equal(result.removedCount, 1, 'D (referenced only by the archived session) is removed')
  await assert.rejects(() => fs.stat(objectPath(idD)))
  // A 与 C 仍在。
  await fs.stat(objectPath(idA))
  await fs.stat(objectPath(idC))
  await rm(home, { recursive: true, force: true })
  console.log('12. attachment cleanup (zstd frames, referenced-set, freshness, archive exclusion) OK')
}

// ── 13. 清理端点：注册命名路由 + 同源/方法防护 + 归档集接线 + 成功响应 ────
{
  registeredTools.clear()
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const workspaceRegistry = { archivedSessionIds: ['session-archived'] }
  const ctx = makeCtx({ webServer, workspaceRegistry })
  plugin.apply(ctx, ctx.__config)
  assert.ok(routes.has('/plugins/dsh-vision-tool/cleanup-attachments'), 'route registered')
  const handler = routes.get('/plugins/dsh-vision-tool/cleanup-attachments').handler
  const callWith = (useHandler) => async (method, headers = {}, body = undefined) => {
    const writes = []
    const res = {
      headersSent: false,
      writeHead(status, heads) { this.status = status; this.heads = heads },
      end(payload) { writes.push(payload) },
    }
    await useHandler({ method, headers, body }, res)
    return { status: res.status, payload: JSON.parse(writes[0] ?? 'null') }
  }
  const call = callWith(handler)
  const wrongMethod = await call('GET', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
  assert.equal(wrongMethod.status, 405)
  const crossOrigin = await call('POST', { origin: 'http://evil.example', host: '127.0.0.1:3080' })
  assert.equal(crossOrigin.status, 403, 'cross-origin POST rejected')
  // DNS-rebinding 形态：Origin 与 Host 同为非回环域名。假 webServer 无
  // host 属性 → lanDeployment=false → 回环绑定语义，非回环 Host 一律拒绝
  //（旧字面同源检查会放行这种请求）。
  const rebound = await call('POST', { origin: 'http://evil.example', host: 'evil.example' })
  assert.equal(rebound.status, 403, 'non-loopback Host rejected even when Origin matches')
  const crossSite = await call('POST', {
    origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site',
  })
  assert.equal(crossSite.status, 403, 'explicit cross-site marker rejected')
  const noOriginLan = await call('POST', { host: '192.168.1.5:3080' })
  assert.equal(noOriginLan.status, 403, 'origin-less non-loopback POST rejected')
  // 同源 POST：对假主目录执行（DSH_HOME 指向假目录，避免碰到真实附件库）。
  // 归档会话引用 d、live 会话引用 e——归档排除后只应删 d。
  const home = join(tmpdir(), `dsh-vision-tool-route-${Date.now()}`)
  const idD = 'd'.repeat(64)
  const idE = 'e'.repeat(64)
  const logOf = (id) => zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', data: { content: [
    { type: 'image', attachment: { attachmentId: `sha256:${id}` } },
  ] } }) + '\n'))
  await mkdir(join(home, 'sessions', 'ws', 'session-archived'), { recursive: true })
  await writeFile(join(home, 'sessions', 'ws', 'session-archived', 'session.jsonl.zstd'), logOf(idD))
  await mkdir(join(home, 'sessions', 'ws', 'session-live'), { recursive: true })
  await writeFile(join(home, 'sessions', 'ws', 'session-live', 'session.jsonl.zstd'), logOf(idE))
  const objectPath = (id) => join(home, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
  for (const id of [idD, idE]) {
    await mkdir(join(home, 'attachments', 'v1', 'objects', id.slice(0, 2)), { recursive: true })
    await writeFile(objectPath(id), Buffer.alloc(8))
  }
  const stale = new Date(Date.now() - 60 * 60_000)
  await utimes(objectPath(idD), stale, stale)
  await utimes(objectPath(idE), stale, stale)
  process.env.DSH_HOME = home
  try {
    const ok = await call('POST', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
    assert.equal(ok.status, 200)
    assert.equal(ok.payload.ok, true)
    assert.equal(ok.payload.removedCount, 1, 'archived-referenced object is removed through the endpoint')
    assert.equal(ok.payload.skippedArchivedSessions, 1, 'archive set flows from workspaceRegistry')
    assert.equal(ok.payload.scannedSessions, 1, 'live session scanned')
    assert.equal(ok.payload.keptCount, 1, 'live-referenced object kept')
    const fs = await import('node:fs/promises')
    await fs.stat(objectPath(idE))
    await assert.rejects(() => fs.stat(objectPath(idD)))
    // 桌面壳转发形态回归：无 Origin + 回环 Host（Electron 主进程转发会删除
    // origin/host/sec-fetch-site，Node fetch 重发 Host 为回环地址）——必须
    // 放行；第二遍 idempotent（d 已删，e 仍保留）。
    const forwarded = await call('POST', { host: '127.0.0.1:3080' })
    assert.equal(forwarded.status, 200, 'origin-less loopback POST (desktop shell forwarding) passes the fence')
    assert.equal(forwarded.payload.ok, true)
    assert.equal(forwarded.payload.removedCount, 0, 'second run removes nothing')
  } finally {
    delete process.env.DSH_HOME
    await rm(home, { recursive: true, force: true })
  }

  // registry 缺席（headless/晚激活）：readArchivedIds 退化为空集，不炸路由。
  registeredTools.clear()
  routes.clear()
  const plainCtx = makeCtx({ webServer, workspaceRegistry: undefined })
  plugin.apply(plainCtx, plainCtx.__config)
  const degradeCall = callWith(routes.get('/plugins/dsh-vision-tool/cleanup-attachments').handler)
  const degradeHome = join(tmpdir(), `dsh-vision-tool-degrade-${Date.now()}`)
  await mkdir(join(degradeHome, 'attachments', 'v1', 'objects', 'ff'), { recursive: true })
  await writeFile(join(degradeHome, 'attachments', 'v1', 'objects', 'ff', 'f'.repeat(64)), Buffer.alloc(8))
  const degradeStale = new Date(Date.now() - 60 * 60_000)
  await utimes(join(degradeHome, 'attachments', 'v1', 'objects', 'ff', 'f'.repeat(64)), degradeStale, degradeStale)
  process.env.DSH_HOME = degradeHome
  try {
    const degraded = await degradeCall('POST', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
    assert.equal(degraded.status, 200)
    assert.equal(degraded.payload.ok, true)
    assert.equal(degraded.payload.skippedArchivedSessions, 0, 'no registry → empty archive set, no crash')
  } finally {
    delete process.env.DSH_HOME
    await rm(degradeHome, { recursive: true, force: true })
  }
  console.log('13. cleanup endpoint (route + guards + archive-set wiring + degradation) OK')
}

// ── 14. webServer 服务缺席时：不注册路由、其余功能不受影响 ─────────────────
{
  registeredTools.clear()
  const ctx = makeCtx({ webServer: undefined })
  plugin.apply(ctx, ctx.__config)
  assert.equal(registeredTools.size, 1, 'tool still registered without webServer')
  console.log('14. webServer-absent degradation OK')
}

// ── 15. 短摘要：任意 "sha256:<hex>" 按唯一前缀跨三层匹配 ──────────────────
// 线上事故形态：纯文本模型会话里模型只能拿到宿主占位文本的 8 位摘要；旧逻辑
// 把短摘要当文件路径解析，报误导性 cannot read。新逻辑零命中/多命中都必须
// 给出可自纠的候选完整 ID。
{
  registeredTools.clear()
  llmStreamCalls = []
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  await ctx.__save({ visionProvider: 'p', visionModel: 'm' })
  const tool = registeredTools.get('recognize_images')
  const refA = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' }
  const refB = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/png' }
  const events = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'image', attachment: refA }] } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'image', attachment: refB }] } },
  ]
  const session = { snapshotEvents: () => events }
  const runWith = async (id) => {
    llmStreamCalls = []
    await tool.execute({ images: [id], prompt: '' }, { agent: { session }, signal: undefined })
    return llmStreamCalls[0].messages[0].content
  }
  // 15a. 8 位短摘要（占位文本同款形态）唯一命中
  let content = await runWith('sha256:' + 'a'.repeat(8))
  assert.equal(content[1].attachment, refA, '8-hex short digest resolves by unique prefix')
  // 15b. 大写形态归一命中
  content = await runWith('sha256:' + 'B'.repeat(8))
  assert.equal(content[1].attachment, refB, 'uppercase digest normalizes to lowercase')
  // 15c. 12 位前缀命中
  content = await runWith('sha256:' + 'a'.repeat(12))
  assert.equal(content[1].attachment, refA, '12-hex prefix resolves')
  // 15d. 完整 64 位 ID 走同一路径（完整 ID 是自身的最长前缀）
  content = await runWith(refA.attachmentId)
  assert.equal(content[1].attachment, refA, 'full id resolves through the same path')
  // 15e. 零命中 → 「未知附件 ID」+ 诊断列出可用完整 ID（一步自纠）
  const missing = await tool.execute(
    { images: ['sha256:' + '9'.repeat(8)] },
    { agent: { session }, signal: undefined },
  )
  assert.match(missing, /所有图片都未能读取/)
  assert.match(missing, /未知附件 ID/)
  assert.match(missing, new RegExp('a'.repeat(64)), 'diagnostics list the full available id')
  assert.match(missing, /诊断：/)
  // 15f. 共享前缀多命中 → 列出全部候选完整 ID
  const refP1 = { attachmentId: 'sha256:' + 'ab12cd34' + 'e'.repeat(56), mediaType: 'image/png' }
  const refP2 = { attachmentId: 'sha256:' + 'ab12cd34' + 'f'.repeat(56), mediaType: 'image/png' }
  const eventsAmbiguous = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'image', attachment: refP1 }] } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'image', attachment: refP2 }] } },
  ]
  const ambiguous = await tool.execute(
    { images: ['sha256:ab12cd34'] },
    { agent: { session: { snapshotEvents: () => eventsAmbiguous } }, signal: undefined },
  )
  assert.match(ambiguous, /匹配到多个附件/)
  assert.match(ambiguous, new RegExp('ab12cd34' + 'e'.repeat(56)), 'candidate 1 full id listed')
  assert.match(ambiguous, new RegExp('ab12cd34' + 'f'.repeat(56)), 'candidate 2 full id listed')
  assert.match(ambiguous, /更长的前缀或完整附件 ID/)
  console.log('15. short-digest prefix resolution (unique/uppercase/zero-hit/ambiguous) OK')
}

// ── 16. pre-step 索引短摘要：agent 有、session 无（线上失明形态）也能命中 ──
{
  registeredTools.clear()
  llmStreamCalls = []
  const ctx = makeCtx()
  plugin.apply(ctx, ctx.__config)
  await ctx.__save({ visionProvider: 'p', visionModel: 'm' })
  const tool = registeredTools.get('recognize_images')
  const ref = { attachmentId: 'sha256:' + 'f'.repeat(64), mediaType: 'image/png' }
  const agent = { id: 'agent-short-digest' } // 故意没有 session
  const { nextCalled } = await ctx.__emitEvent('agent/pre-step', {
    agent,
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
    turn: 1,
    step: 1,
  })
  assert.ok(nextCalled, 'listener calls next()')
  llmStreamCalls = []
  await tool.execute({ images: ['sha256:' + 'f'.repeat(8)], prompt: '' }, { agent, signal: undefined })
  assert.equal(
    llmStreamCalls[0].messages[0].content[1].attachment,
    ref,
    'short digest hits the per-agent pre-step index',
  )
  console.log('16. short digest via pre-step index (agent-only exec) OK')
}

// ── 17. 孪生开关：listModels 只放行被打开的模型，全关 → 空（目录丢弃空组）────
{
  registeredTools.clear()
  const ctx = makeCtx()
  ctx.__llm.providers = [{ id: 'glm', name: '智谱 GLM' }]
  ctx.__llm.models = {
    glm: [
      { id: 'glm-4.6', name: 'GLM-4.6', inputModalities: ['text'] },
      { id: 'glm-5', name: 'GLM-5', inputModalities: ['text'] },
    ],
  }
  plugin.apply(ctx, ctx.__config)
  const twin = ctx.__llm.adapters.get('glm-vision')
  const key = (model) => JSON.stringify(['glm', model])
  // 默认（无 twinEnabled）→ 全关 → 空（聊天页不出现孪生条目）
  assert.deepEqual(await twin.listModels(), [], 'default: all toggles off → empty twin group')
  // 只开 glm-5 → 只列它，且仍是孪生路由 + 可收图声明
  await ctx.__save({ twinEnabled: { [key('glm-5')]: true } })
  let models = await twin.listModels()
  assert.deepEqual(models.map((m) => m.id), ['glm-5'])
  assert.equal(models[0].provider, 'glm-vision')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'], 'twin still declares image input')
  // 开 glm-4.6、关 glm-5 → 只列 glm-4.6（逐模型独立）
  await ctx.__save({ twinEnabled: { [key('glm-4.6')]: true, [key('glm-5')]: false } })
  models = await twin.listModels()
  assert.deepEqual(models.map((m) => m.id), ['glm-4.6'])
  // 全关 → 空（对应目录丢弃空组、孪生整条消失）
  await ctx.__save({ twinEnabled: {} })
  assert.deepEqual(await twin.listModels(), [], 'all off → empty')
  console.log('17. twin listModels per-model toggle (default/subset/switch/empty) OK')
}

// ── 18. 会话工具门控：非孪生 assemble 不带 recognize_images，孪生/未知保留 ────
{
  registeredTools.clear()
  const baseAssembly = {
    sections: [],
    contexts: [],
    tools: [
      { name: 'recognize_images', description: 'r', parameters: {} },
      { name: 'read', description: 'x', parameters: {} },
    ],
    variables: {},
  }
  const namesOf = (out) => out.tools.map((t) => t.name)

  // 可变投影载体：stateOf 返回 proj.current（每次断言前改写）
  const proj = { current: null }
  const ctx = makeCtx({
    sessionProjections: {
      stateOf: (_session, key) => {
        assert.equal(key, 'modelSelection')
        return proj.current
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'chat' }) },
  })
  plugin.apply(ctx, ctx.__config)

  // 18a. 投影 pending 非孪生 → recognize_images 被移除，其它工具保留
  proj.current = { pending: { provider: 'glm', model: 'glm-5' }, lastUsed: null }
  assert.deepEqual(
    namesOf(await ctx.__emitAssemble(baseAssembly, { agent: { session: {} } })),
    ['read'],
    'non-twin conversation drops recognize_images',
  )
  // 18b. 投影 pending 孪生（-vision）→ 保留
  proj.current = { pending: { provider: 'glm-vision', model: 'glm-5' }, lastUsed: null }
  assert.deepEqual(
    namesOf(await ctx.__emitAssemble(baseAssembly, { agent: { session: {} } })),
    ['recognize_images', 'read'],
    'twin conversation keeps recognize_images',
  )
  // 18c. 无 agent（全局 assemble，非会话）→ 保留（fail-open）
  proj.current = { pending: { provider: 'glm', model: 'm' }, lastUsed: null }
  assert.deepEqual(
    namesOf(await ctx.__emitAssemble(baseAssembly, {})),
    ['recognize_images', 'read'],
    'subject-less assembly keeps the tool (fail-open)',
  )
  // 18d. 投影缺席 → requestHeader 回退（非孪生）→ 移除
  const ctxH = makeCtx({ sessionProjections: undefined, agentDefaultModel: undefined })
  plugin.apply(ctxH, ctxH.__config)
  const headerAgent = { session: { requestHeader: () => ({ config: { provider: 'openai', model: 'gpt' } }) } }
  assert.deepEqual(
    namesOf(await ctxH.__emitAssemble(baseAssembly, { agent: headerAgent })),
    ['read'],
    'requestHeader fallback (non-twin) drops the tool',
  )
  // 18e. 投影 + header 缺席 → agentDefaultModel 回退（非孪生）→ 移除
  const ctxD = makeCtx({
    sessionProjections: undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) },
  })
  plugin.apply(ctxD, ctxD.__config)
  assert.deepEqual(
    namesOf(await ctxD.__emitAssemble(baseAssembly, { agent: { session: {} } })),
    ['read'],
    'agentDefaultModel fallback (non-twin) drops the tool',
  )
  // 18f. 全部未知（无投影/无 header/无默认）→ 保留（fail-open，不误藏孪生工具）
  const ctxU = makeCtx({ sessionProjections: undefined, agentDefaultModel: undefined })
  plugin.apply(ctxU, ctxU.__config)
  assert.deepEqual(
    namesOf(await ctxU.__emitAssemble(baseAssembly, { agent: { session: {} } })),
    ['recognize_images', 'read'],
    'fully unknown route keeps the tool (fail-open)',
  )
  console.log('18. assemble tool gate (non-twin drops / twin keeps / fallbacks / fail-open) OK')
}

// ── 19. Config schema：三字段 .volatile()（0.1.7 设置契约），缺省空记录，非法值拒绝 ─
{
  // volatile 字段解析为可 .get() 的引用（官方 agent-default-model 同款读取方式）；
  // read 兼容 plain 返回，聚焦值语义本身。
  const read = (v) => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
  const parsed = plugin.Config({})
  assert.equal(typeof parsed.visionProvider.get, 'function', 'volatile field parses to a readable ref')
  assert.equal(typeof parsed.twinEnabled.get, 'function', 'twinEnabled parses to a readable ref')
  assert.deepEqual(read(parsed.visionProvider), '', 'visionProvider defaults to an empty string')
  assert.deepEqual(read(parsed.twinEnabled), {}, 'twinEnabled defaults to an empty record')
  const k = JSON.stringify(['glm', 'glm-5'])
  assert.deepEqual(
    read(plugin.Config({ twinEnabled: { [k]: true } }).twinEnabled),
    { [k]: true },
    'twinEnabled record of string→boolean accepted',
  )
  assert.throws(() => plugin.Config({ twinEnabled: 'nope' }), /expected object/)
  assert.throws(() => plugin.Config({ twinEnabled: { k: 'notbool' } }), /expected boolean/)
  console.log('19. Config volatile schema (default/record/reject) OK')
}

console.log('\nAll dsh-vision-tool host-half smoke tests passed.')
