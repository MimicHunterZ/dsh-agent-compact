# ctxc-1 `context_compact` 引擎优化 — A/B 实测数据

> 用途：后续发布持久化插件（Step 2）时的数据说明依据。
> 会话：`session-b84b9d8d-f54e-44b2-bd25-09bfdb789f11`
> 插件：动态插件 `ctxc-1`（pkg-8 → pkg-9 → pkg-10）
> 引擎：`@deepseek-ai/dsh-compaction-basic`（`BasicCompactionEngine`）运行时补丁
> 日期：2026-08（本机时间）

---

## 1. 被测对象

对运行中的 `compaction` 引擎实例做两个方法覆盖（不动类定义、不动部署文件）：

1. `compactRegion(start, end, agent, signal)` — 包装：先把边界 `{start, end}` 存到实例（`this._pending`），再调用原始事务（校验/平衡/锁/替换全复用）。
2. `summarize(input, agent, signal)` — 替换：忽略引擎构建的"仅区间消息"，改为
   - **全量上下文输入**：从表面节点 0 到区间末尾（`surface[0..endPos]` → `session.deriveEventMessage`），使摘要请求成为最后一次路由请求的**真前缀**，最大化 KV-cache 命中；
   - **序号锚指令**：指令末尾追加"上面共 N 条消息，只压缩第 #k..#m 条；#k 之前为既有上下文、#m 之后为近期记录，均不得并入"——区间边界用 1-based 消息序号表达（引擎代码层知道精确的 k、m），不往消息流里插标记（那会破坏前缀匹配）。

**为什么不插 `<compaction-region-start/end>` 标记**：DeepSeek 缓存为严格前缀匹配，往消息流中间插入任何 token 都会让后续 token 位置错位 → 区间+尾部全部 miss（比现状更贵，见 §5 的失败教训）。

## 2. 计费价格（用户提供，元 / 百万 tokens）

| 模型 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-v4-flash | 0.02 | 1.00 | 2.00 |
| deepseek-v4-pro | 0.025 | 3.00 | 6.00 |

命中价 : 未命中价 ≈ 1 : 50。这是优化成立的前提（把区间 token 从"未命中"搬到"命中"）。

## 3. 方法与数据来源

- 三次真实中段压缩（同一轮内顺序执行），usage 来自**持久化 `compaction/summary` 事件**（`session.events` 中按 `compactionId` 匹配，`findSummaryUsage`）；patched 路径的 usage 同时由补丁内自建 assembler 收集。
- `usage` 字段语义（dsh-llm 类型注释）：`inputTokens` = 未命中输入；`cacheReadTokens` = 命中输入；两者不相交。
- 原始数据：见 `ab-data.json`。

## 4. 实测结果

| 运行 | 引擎 | 区间 seqs | 被压 token | 输入 miss | 输入 hit | 命中率 | 输入费用 | 输出费用 | 总费用 |
|---|---|---|---|---|---|---|---|---|---|
| run1 | **patched** | 81778..87981 | 12,436 | **470** | 47,232 | **99.0%** | ¥0.001415 | ¥0.008876 | ¥0.010291 |
| run2 | **original** | 87988..101545 | 25,213 | 6,322 | 48,128 | 88.4% | ¥0.007285 | ¥0.018980 | ¥0.026265 |
| run3 | patched* | 101552..123174 | 33,751 | 6,289 | 66,688 | 91.4% | ¥0.007623 | ¥0.003638 | ¥0.011261 |

\* run3 为同轮第 3 次压缩，表面已含前两次的 checkpoint，与"最后一次请求"失配（见 §6）。

### 4.1 关键对比

- **干净对比（run1 vs run2）**：输入费用 ¥0.001415 vs ¥0.007285 → **patched 省 80.6%**。
- **按被压 token 归一化**：每百万被压 token 的输入费用，patched ¥0.114 vs original ¥0.289 → **便宜 2.5 倍**。
- **结构性结论**：patched 的 miss 恒 ≈ 指令长度（470 tokens），**与区间大小无关**；original 的 miss ≈ 区间消息长度（6,322），**随区间线性增长**。同区间外推（25K tokens）：patched ≈ ¥0.0014，original ≈ ¥0.0073 → ~81% 更便宜。

### 4.2 run1 补丁诊断（证明全量输入真的发出去了）

```
engineDiag: surfaceNodes=178, sentMessages=62, sentChars=122,492,
            skippedEvents=0, k=26, m=62, regionStart=101552, regionEnd=123174
```

62 条消息 = 表面 0..61 全量；k=26..m=62 正是区间消息的 1-based 序号范围。摘要内容正确性经人工核对：只覆盖区间内容，**未合并前缀旧 checkpoint、未碰尾部**。

## 5. 过程中抓到的两个问题（也值得写进发布说明）

1. **max-tokens 截断**：deepseek-v4-flash **默认开思考模式**（reasoning tokens 3,621~7,982，run3 甚至为 0，随机）。pkg-8 用引擎默认 8,192 上限时，思考 + 正文超限 → 摘要不完整。修复：补丁内 `maxTokens = max(引擎配置, 16384)` + 指令加"目标 2000 tokens 以内"的简洁约束。
2. **往消息流插标记是反优化**：`<compaction-region-start>` 这类标记若插在消息流中间，会从标记处打断前缀匹配，区间+尾部全 miss（估算比现状还贵 ~67%）。边界信息只能放**末尾追加的指令**里（指令本来就是新 token，不额外破坏缓存）。

## 6. 同轮连续压缩的前缀失配（run3 现象，诚实记录）

- 同一模型轮次内，每做一次压缩，表面就有一段节点被换成 checkpoint；而"最后一次路由请求"（本轮开始时发出）仍是原始节点。
- 下一次压缩的全量输入从**第一个新 checkpoint 的位置起**与最后一次请求失配 → 从该位置到区间末尾全部计为 miss（run3：6,289）。
- 这不是缓存失效，是**前缀不再匹配**；"刷新"发生在**下一轮请求**——checkpoint 进入新请求后，前缀重新对齐，命中恢复。
- 对使用方式的影响：**每轮结束压一段**（表面=最后一次请求）时，patched 的复用完全成立；同一轮内连续压多段，后段的复用收益会暂时下降。

## 7. 输出（思考）成本占比

输出费是单次压缩的大头（run1 中占 86%），且与引擎无关（思考模式随机开闭）。发布说明中应明确：**优化针对的是输入侧**（区间 miss → hit）；输出侧（含思考）不受影响。若想进一步省钱，需在 `purpose: 'compaction'` 的请求上关闭思考模式或调大输出上限。

## 8. 复现步骤

1. 加载插件 `ctxc-1`（pkg-10），`context_surface` 取两个平衡边界 seq。
2. `context_compact(start, end, engine='patched')` → 返回 `usage`（miss/hit/output/reasoning）。
3. `context_compact(start2, end2, engine='original')` → 对比 `usage`。
4. 注意：**先跑 patched**（表面未动、前缀匹配最干净）；baseline 只传区间，不受表面变化影响，顺序无所谓。

## 9. 相关产物

| 项 | 值 |
|---|---|
| run1 归档 | `/var/folders/43/.../2dadeeb5dbdc-ab-patched.txt`（49,757 chars） |
| run2 归档 | `/var/folders/43/.../e1e1582474dd-ab-baseline.txt`（100,900 chars） |
| run3 归档 | `/var/folders/43/.../980d17f6c633-ab-patched2.txt`（135,289 chars） |
| run1 compactionId | `f2433ca6-03ff-462d-a459-727c4d38d20d` |
| run2 compactionId | `f4327d73-1dc3-441d-947e-8ff7cb448713` |
| run3 compactionId | `be91c6df-63e1-42fe-8d0e-0b6ddc568e0b` |

## 10. 结论（一句话）

**全量上下文输入 + 序号锚指令：输入命中率从 88% 提到 99%（干净场景），miss 从"随区间增长"变为"恒定 ≈ 指令"；同区间输入费用省 ~80%，每被压 token 便宜 2.5 倍。代价是同一轮内连续压缩时前缀暂时失配，下一轮自动恢复。**
