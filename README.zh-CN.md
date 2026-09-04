# agent-compact

[English](README.md) · 简体中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供上下文压缩:让 **agent 自主调用** `context_compact`,把对话中一段它选定的、已经用完不再需要的区间,替换成 agent 自己写的检查点。配套的 `context_compact_auto` 不指定区间,由引擎自动选出范围并压缩;`context_ask_precompact` 则用 fork 式子代理查询压缩前的上下文。

## 为什么

压缩通常意味着全量清扫:官方引擎只能从会话开头压,开头的任务规划、方向也会随着信息压缩丢失一部分。`context_compact` 只压缩 **agent 选中的那一段** —— 一个完成的工作步骤、一段排查完的日志、一段跑偏的讨论 —— 重要的开头和最近的内容原样保留。**区间压缩把压缩带来的信息丢失降到最小** —— 像人的记忆一样,中间的记忆不是无差别压缩:能总结的巩固成检查点,重要的细节逐字保留 —— 哪些内容真的没用了,由 agent 自己判断,只压那一部分。

典型的使用时机:

- 一个任务步骤完成了 —— 压掉它,剩余步骤和活动指令保持存活;
- 排查完的 bug、一个错误的调研方向 —— 把这段压成简短"错在哪 / 根因 / 修正方向"记录;
- 开头的需求过期了 —— 压掉开头,重新表述当前意图。

## 它做什么

- agent 用 `startAnchor` / `endAnchor` 圈定区间(唯一前缀匹配,全角/半角标点不敏感),并传入**强制要求**的 `summary` —— 自己写的 Markdown 检查点。
- 原始区间全文先归档到 spill(`~/.dsh/spill/session-<hash>/<hex>-<序号>.txt`,顺序命名、重启安全);归档定位符在工具结果里返回,模型可随时读回原文。
- 宿主引擎执行官方事务 —— 边界校验、工具对平衡、表面替换 —— **不发起独立的 LLM 摘要器请求**。

工具调用本身发生在 agent 正常轮次内,按普通轮次正常计费;省掉的只是官方引擎为同一区间"额外再发一次摘要器请求"这件事。

### 自动选择范围

`context_compact_auto` 不指定区间:引擎自动选出一个可压缩范围,用引擎的摘要器检查点替换。它**无条件压缩**——没有压力阈值门控——并报告压掉了什么,或没有可压缩项(表面上还没有可压缩的区间)。由于自动路径不提供 agent 写的检查点,它使用引擎的摘要器(Llm 调用)。

### 查询压缩前的上下文(压缩前状态的 fork)

`context_ask_precompact(question)` 让 agent 对**最近一次 `context_compact` 之前**的上下文提问。它通过 agent 注册表创建一个 fork 式子代理,seed 用父会话在**压缩前最后一条完整 `turn/end`** 处的日志——因此被压掉的那段 span 仍是原始内容,没有被折叠成检查点。子代理通过 `composeFrom` join 同一组合(同一 preset、system prompt、tools),其上下文与主 agent 压缩前的状态一致,并可复用同一 warm-prefix 的 KV-cache。主会话表面与 cache 完全不动;答案返回。

工具不新增依赖:用 `ctx.agents.create` 创建带 seed 的子代理,并用 `agentPresets` 的 `composeFrom` 组合。

## 安装

```sh
# 从发布仓库安装
dsh plugin --profile web add @mimichunterz/agent-compact

# 或本地目录
dsh plugin --profile web add ./agent-compact
```

`dsh plugin` 会在 profile 目录内转发给 pnpm 并把 bundle 追加到 `dsh.profile.bundles`(参见官方 [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md))。**重启 profile 后**,所有会话都能看到 `context_compact` 工具。

插件自带的 `cordis.patch.yml` 会把 spill 归档根目录固定到 `~/.dsh/spill`(部署可用 profile 的 `cordis.patch.yml` 再覆盖)。

## 卸载

```sh
dsh plugin --profile web remove @mimichunterz/agent-compact
```

`dsh plugin remove` 在 profile 目录内转发给 `pnpm remove`:卸载包,并把 bundle 从 `dsh.profile.bundles` 中剔除。**重启 profile 后**,所有会话都不再看到 `context_compact` 工具。无论当初是从发布仓库还是本地目录安装的,卸载都用同一个包名。

如果插件是通过 profile 的 `cordis.patch.yml` 行挂载的(dev 模式),还需要把那一行删掉,否则下次启动 patch 会把它重新挂上。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoArchive` | `true` | `context_compact` 在替换区间前先把原始区间全文存到 spill 归档 |

通过 profile 的 `cordis.patch.yml` 或 bundle patch 插入行来配置。

## 工作原理

- **agent 自写检查点**:`summary` 是强制参数,工具路径总是走 agent 写的检查点。`patchEngine()`(见 `src/optimizer.ts`)包装引擎的 `summarize()` —— 存在 `_externalSummary`(按会话 id 一次性消费)时直接返回该文本;没有时才转发 stock 实现,该分支只服务于自动压缩路径,保持官方行为不变。
- **锚点定位**(`src/normalize.ts`):`normText` 折叠空白并把 CJK 全角标点映射为半角(，→, 等),锚点与节点文本共用同一函数;仍保持**唯一前缀**语义(0 命中 → not found + 最近节点提示;多命中 → AMBIGUOUS)。
- **重启安全的顺序归档**:fs 扫描会话目录取 `max+1` 顺序递增,无空洞;后端自带随机 hex 前缀,文件名永不冲突。
- **不删除任何消息**:调用方的 assistant 消息(它的推理 + 携带 `summary` 的 tool-call)及其 tool/result 都留在表面 —— 它们不在压缩区间里,shadow 掉就会丢掉 agent 压缩前的推理。因此 summary 会同时出现在检查点(区间位置)和 tool-call 参数里 —— 为了不丢消息而接受这份冗余。

## 兼容性

- 针对 DeepSeek Harness `0.1.0-rc.6`(`@deepseek-ai/dsh-compaction-basic@0.1.0-rc.6`)构建与验证。
- 每个会话**同一时刻只允许一次压缩**(引擎事务串行);锚点每次重新解析,重复压缩不会因之前的检查点而过期。
- 本地 spill 后端固定 root;换用其他后端时归档功能按可用性降级(无 `root` 字段则回退内存计数),压缩本身不受影响。

## License

MIT。补丁逻辑参考 `@deepseek-ai/dsh-compaction-basic` 及 DeepSeek Harness 相关包(MIT,Copyright DeepSeek)—— 见 [`LICENSE`](LICENSE)。
