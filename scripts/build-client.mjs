// Build lib/client.js for @mimichunterz/agent-compact (browser half of the
// "上下文" surface panel). The browser bundle must be self-contained under
// window.__ModuleLoader__.load(); zod 4.4.3 is inlined (same version the
// typert remote descriptors need) by extracting the exact zod region from the
// shipped dsh-api-remotes client bundle, so the schema instances here carry
// the same `_zod` marker the client typert registry validates.
//
// Loop: edit this script -> `node scripts/build-client.mjs` -> refresh page.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 1. extract the inlined zod 4.4.3 region from dsh-api-remotes ----
const apiRemotesPath = '/Users/mimiczhang/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js'
const apiRemotes = readFileSync(apiRemotesPath, 'utf8').split('\n')
// region starts at the `//#region ...zod/v4/core/core.js` line and ends after
// classic/schemas.js's `//#endregion` (line 4275, 0-based 4274).
const zodStart = apiRemotes.findIndex((l) => l.includes('//#region') && l.includes('zod/v4/core/core.js'))
const schemasRegion = apiRemotes.findIndex((l) => l.includes('zod/v4/classic/schemas.js'))
const zodEnd = apiRemotes.findIndex((l, i) => i > schemasRegion && l.trim() === '//#endregion')
const zodCode = apiRemotes.slice(zodStart, zodEnd + 1).join('\n')
if (!zodCode.includes('function readonly')) throw new Error('zod extraction failed: missing readonly factory')

// ---- 2. head ----
const head = `window.__ModuleLoader__.load({
	id: "@mimichunterz/agent-compact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		let react = require("react");
		react = __toESM(react, 1);
`

// ---- 3. tail: typert descriptors + CSS + view + apply ----
const tail = `
		//#region typert.remote-client (inlined descriptors)
		const _ctxSurface_read_request$schema = object({
			'sessionId': intersection(string(), unknown()).readonly(),
		})
		const _ctxSurface_read_block$schema = object({
			'kind': union([literal("text"), literal("reasoning"), literal("tool-call"), literal("tool-result"), literal("image"), literal("block")]).readonly(),
			'label': string().readonly().optional(),
			'text': string().readonly(),
			'chars': number().readonly(),
		})
		const _ctxSurface_read_row$schema = object({
			'seq': number().readonly(),
			'type': string().readonly(),
			'text': string().readonly(),
			'chars': number().readonly(),
			'blocks': array(_ctxSurface_read_block$schema).readonly(),
		})
		const _ctxSurface_read_result$schema = union([object({
			'ok': literal(true).readonly(),
			'value': object({
				'rows': array(_ctxSurface_read_row$schema).readonly(),
			}).readonly(),
		}), object({
			'ok': literal(false).readonly(),
			'error': object({
				'code': string().readonly(),
				'message': string().readonly().optional(),
			}).readonly(),
		})])
		const TYPERT_REMOTE = {
			package: '@mimichunterz/agent-compact',
			descriptors: [{
				id: '@mimichunterz/agent-compact#ctxSurface/read',
				service: 'ctxSurface',
				namespace: 'ctxSurface',
				method: 'read',
				invocation: { kind: 'direct' },
				parameters: [{
					name: 'request',
					wire: 'request',
					source: 'json',
					codec: {
						mode: 'strict',
						typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadRequest',
						schema: _ctxSurface_read_request$schema,
					},
				}],
				result: {
					mode: 'strict',
					typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadResult',
					schema: _ctxSurface_read_result$schema,
				},
				sourceLocation: { file: 'src/ctx-surface.ts', line: 160, column: 3 },
			}],
		}
		//#endregion

		//#region ctx-surface css
		const CSS_TAG = "@mimichunterz/agent-compact/ctx-surface.css"
		const css = ${JSON.stringify(`/* ctx-surface panel — cx1 prefixed, trajectory-derived */
.cx1root{--dsh-trajectory-toolbar-height:32px;box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;display:flex;overflow:hidden}
.cx1ledger{z-index:0;isolation:isolate;--dsh-trajectory-bottom-clearance:calc(var(--dsh-composer-height,152px) + 16px);flex:1;min-width:0;min-height:0;display:flex;position:relative;overflow:hidden}
/* toolbar */
.cx1tbRoot{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);height:var(--dsh-trajectory-toolbar-height);flex:none;justify-content:center;align-items:center;gap:8px;display:flex;padding:0 12px}
.cx1tbInner{min-width:0;flex:1;justify-content:space-between;align-items:center;gap:8px;display:flex}
.cx1tbActions{align-items:center;gap:2px;display:flex}
.cx1tbAction{box-sizing:border-box;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);justify-content:center;align-items:center;gap:4px;display:inline-flex;padding:4px 6px;border-radius:4px}
.cx1tbAction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cx1tbAction[data-pressed=true]{color:var(--dsw-alias-state-business-primary)}
.cx1tbAction[data-primary=true]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-1)}
.cx1tbAction[data-primary=true]:hover{background:var(--dsw-alias-state-business-primary);opacity:.9}
.cx1tbAction[data-primary=true]:disabled{opacity:.4;cursor:default}
.cx1tbIcon{width:14px;height:14px;flex:none}
.cx1tbSearch{margin-left:auto;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:4px;font:var(--dsw-font-xxs-12);min-width:140px;padding:3px 8px}
.cx1tbSearch::placeholder{color:var(--dsw-alias-label-caption)}
.cx1tbSearch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.cx1tbStats{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);white-space:nowrap}
/* timeline */
.cx1tlRoot{z-index:1;isolation:isolate;border-bottom:1px solid var(--dsw-alias-border-l2);user-select:none;flex:none;position:relative}
.cx1tlPlot{background:var(--dsw-alias-bg-layer-2);grid-template-columns:44px minmax(0,1fr);height:50px;display:grid;overflow:hidden}
.cx1tlLabels{border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font:var(--dsw-font-xs-13);font-size:10px;line-height:1;position:relative}
.cx1tlLabels span{text-align:right;justify-content:flex-end;align-items:center;height:8px;display:flex;position:absolute;right:3px}
.cx1tlLabels span:first-child{top:7px}.cx1tlLabels span:nth-child(2){top:21px}.cx1tlLabels span:nth-child(3){top:35px}
.cx1tlTrack{cursor:crosshair;touch-action:none;position:relative;overflow:hidden}
.cx1tlLanes{z-index:2;top:7px;bottom:7px;left:0;width:100%;position:absolute}
.cx1tlSpan{top:0;background:var(--dsw-alias-label-secondary);opacity:.85;border-radius:1px;min-width:2px;height:8px;position:absolute;cursor:pointer}
.cx1tlSpan:hover{z-index:1;opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2),0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 80%,transparent)}
.cx1tlSpan[data-timeline-span=user]{background:var(--dsw-alias-state-business-primary)}
.cx1tlSpan[data-timeline-span=message]{background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%,var(--dsw-alias-state-error-secondary))}
.cx1tlSpan[data-timeline-span=tool]{background:var(--dsw-alias-state-warn-label)}
.cx1tlSpan[data-selected=false]{opacity:.2}
.cx1tlSpan[data-current=true]{z-index:1;opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2),0 0 0 2px var(--dsw-alias-state-business-primary)}
.cx1tlSelection{z-index:1;top:0;bottom:0;left:var(--cx1-sel-left);width:var(--cx1-sel-width);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);min-width:1px;box-shadow:-100vw 0 0 100vw color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent),100vw 0 0 100vw color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent);pointer-events:none;position:absolute}
.cx1tlSelectionEdges{z-index:4;top:0;bottom:0;left:var(--cx1-sel-left);width:var(--cx1-sel-width);pointer-events:none;min-width:1px;position:absolute}
.cx1tlSelectionEdges:before,.cx1tlSelectionEdges:after{background:var(--dsw-alias-state-business-primary);content:"";width:3px;position:absolute;top:0;bottom:0}
.cx1tlSelectionEdges:before{left:0}.cx1tlSelectionEdges:after{right:0}
.cx1tlHoverLine{z-index:4;top:0;bottom:0;left:clamp(0px, calc(var(--cx1-hover-left) - 1px), calc(100% - 2px));background:var(--dsw-alias-state-business-primary);pointer-events:none;width:2px;position:absolute}
.cx1tlTurnBoundary{z-index:3;top:0;bottom:0;background:var(--dsw-alias-border-l2);pointer-events:none;width:1px;position:absolute}
/* table */
.cx1tblPane{min-width:0;padding-bottom:var(--dsh-trajectory-bottom-clearance,0px);flex:1;position:relative;overflow:hidden auto}
.cx1tbl{width:100%;border-collapse:collapse;font:var(--dsw-font-xxs-12)}
.cx1tblRow{position:relative;cursor:pointer}
.cx1tblRow[data-kind=tool] td{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary)}
.cx1tblRow:hover td{background:var(--dsw-alias-interactive-bg-hover)}
.cx1tblRow[data-selected=true] td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.cx1tblRow td{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 8px;vertical-align:top}
.cx1tblSeq{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);width:56px;white-space:nowrap}
.cx1tblSeqBadge{display:inline-block;min-width:18px;text-align:center;border:1px solid var(--dsw-alias-border-l2);border-radius:3px;padding:0 2px}
.cx1tblKind{display:inline-block;color:var(--dsw-alias-label-caption);border:1px solid var(--dsw-alias-border-l2);border-radius:3px;font-size:10px;padding:0 3px;margin-right:6px}
.cx1tblKind[data-kind=user]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}
.cx1tblKind[data-kind=message]{color:var(--dsw-alias-label-primary)}
.cx1tblKind[data-kind=tool]{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label) 40%,transparent)}
.cx1tblText{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);max-height:9em;overflow:hidden}
.cx1tblToolCall{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.cx1tblEmpty{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);text-align:center;padding:24px}
.cx1tblErr{color:var(--dsw-alias-state-error-label);font:var(--dsw-font-xxs-12);text-align:center;padding:24px}
/* detail */
.cx1det{border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:none;width:360px;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.cx1detHeader{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);height:32px;flex:none;justify-content:space-between;align-items:center;gap:8px;display:flex;padding:0 10px}
.cx1detTitle{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cx1detClose{box-sizing:border-box;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;border-radius:4px}
.cx1detClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cx1detBody{flex:1;min-height:0;overflow:hidden auto;padding:10px}
.cx1detMeta{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.cx1detMetaRow{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.cx1detMetaRow b{color:var(--dsw-alias-label-primary);font-weight:600}
.cx1detSection{margin-top:10px}
.cx1detSectionTitle{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.cx1detBlock{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px;overflow:hidden}
.cx1detBlockHead{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.cx1detBlockKind{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption)}
.cx1detBlockChars{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption)}
.cx1detBlockBody{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;max-height:12em;overflow:hidden auto;padding:6px 8px}
.cx1detBlockBody[data-code=true]{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary)}
.cx1detPlaceholder{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);text-align:center;padding:40px 12px}
`)}
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style")
			tag.dataset.plugin = "@mimichunterz/agent-compact"
			tag.dataset.pluginCss = CSS_TAG
			tag.textContent = css
			document.head.appendChild(tag)
		}
		//#endregion

		//#region ctx-surface view
		const EMPTY_ROWS = []
		function laneOf(type) {
			return type === 'tool/result' ? 2 : type === 'assistant/message' ? 1 : 0
		}
		function rowKind(type) {
			return type === 'user/message' ? 'user' : type === 'assistant/message' ? 'message' : 'tool'
		}
		function isToolRow(row) { return row.type === 'tool/result' }
		function isSelectableRow(row) { return row.type === 'user/message' || row.type === 'assistant/message' }
		function toolCallName(row) {
			for (const b of row.blocks) if (b.kind === 'tool-call' && b.label) return b.label
			for (const b of row.blocks) if (b.kind === 'tool-call') return b.text.slice(0, 40)
			return null
		}
		function isToolCallOnly(row) {
			if (row.type !== 'assistant/message') return false
			let hasCall = false, hasText = false
			for (const b of row.blocks) {
				if (b.kind === 'tool-call') hasCall = true
				else if (b.kind === 'text' && b.text.trim()) hasText = true
			}
			return hasCall && !hasText
		}
		function normAnchor(s) {
			return String(s).toLowerCase().replace(/\\s+/g, '').replace(/[\\p{P}\\p{S}]/gu, '')
		}
		function uniqueAnchorPrefix(rows, idx) {
			const raw = rows[idx].text || ''
			const norm = normAnchor(raw)
			const others = []
			for (let i = 0; i < rows.length; i++) {
				if (i === idx) continue
				const o = normAnchor(rows[i].text || '')
				if (o) others.push(o)
			}
			let len = Math.min(10, norm.length)
			while (len < Math.min(300, norm.length)) {
				const prefix = norm.slice(0, len)
				let clash = false
				for (const o of others) { if (o.startsWith(prefix)) { clash = true; break } }
				if (!clash) break
				len++
			}
			let end = len
			while (end < raw.length && end < len + 4 && raw[end] !== ' ' && raw[end] !== '\\n' && raw[end] !== '\\t') end++
			return raw.slice(0, Math.min(end, raw.length)) || raw
		}
		function compressPrompt(rows, startIdx, endIdx) {
			const start = uniqueAnchorPrefix(rows, startIdx)
			const end = uniqueAnchorPrefix(rows, endIdx)
			return '区间起点该消息的开头文本是：「' + start + '」\\n区间终点该消息的开头文本是：「' + end + '」\\n\\n请调用 context_compact 压缩这一段区间：startAnchor 填上面的起点文本，endAnchor 填上面的终点文本；检查点（summary）由你自己编写，必须是 Markdown 且比原区间小，保留关键路径/命令/ID 与原始需求、方向。'
		}
		function toolbarIcon(kind) {
			if (kind === 'clock') return { type: 'svg', body: '<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 3.5V7l2.25 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' }
			return null
		}
		function CtxSurfaceView(props) {
			const { sessionId, readSurface } = props
			const [rows, setRows] = react.useState(EMPTY_ROWS)
			const [loading, setLoading] = react.useState(false)
			const [error, setError] = react.useState(null)
			const [startIdx, setStartIdx] = react.useState(null)
			const [endIdx, setEndIdx] = react.useState(null)
			const [detailIdx, setDetailIdx] = react.useState(null)
			const [searchQuery, setSearchQuery] = react.useState('')
			const [equalWidth, setEqualWidth] = react.useState(false)
			const [collapseTurns, setCollapseTurns] = react.useState(false)
			const [collapseCalls, setCollapseCalls] = react.useState(false)
			const [hoverLeft, setHoverLeft] = react.useState(null)
			const [refreshTick, setRefreshTick] = react.useState(0)
			const refreshTimer = react.useRef(null)
			const load = react.useCallback(() => {
				if (!sessionId || !readSurface) return
				setLoading(true)
				readSurface({ sessionId }).then((result) => {
					if (result && result.ok === true) {
						setRows(result.value.rows || EMPTY_ROWS)
						setError(null)
					} else {
						setRows(EMPTY_ROWS)
						setError((result && result.error && result.error.message) || '读取 surface 失败')
					}
				}).catch((err) => {
					setRows(EMPTY_ROWS)
					setError(err && err.message ? err.message : String(err))
				}).finally(() => setLoading(false))
			}, [sessionId, readSurface])
			react.useEffect(() => { load() }, [load])
			react.useEffect(() => () => { if (refreshTimer.current !== null) { clearTimeout(refreshTimer.current); refreshTimer.current = null } }, [])
			const handleRefresh = react.useCallback(() => {
				if (refreshTimer.current !== null) return
				refreshTimer.current = setTimeout(() => { refreshTimer.current = null; setRefreshTick((t) => t + 1) }, 350)
			}, [])
			react.useEffect(() => { if (refreshTick > 0) load() }, [refreshTick, load])
			const inputActions = props.inputActions
			const handleSelect = react.useCallback((idx, row) => {
				if (isToolRow(row)) { setDetailIdx(idx); return }
				if (startIdx === null) { setStartIdx(idx); setEndIdx(null); return }
				if (idx === startIdx) { setStartIdx(null); setEndIdx(null); return }
				setEndIdx(idx)
			}, [startIdx])
			const handleCompress = react.useCallback(() => {
				if (startIdx === null || endIdx === null || !inputActions || !inputActions.setDraft) return
				const lo = Math.min(startIdx, endIdx)
				const hi = Math.max(startIdx, endIdx)
				inputActions.setDraft(compressPrompt(rows, lo, hi))
				setStartIdx(null); setEndIdx(null)
			}, [startIdx, endIdx, rows, inputActions])
			const filtered = react.useMemo(() => {
				if (!searchQuery.trim()) return rows
				const q = searchQuery.toLowerCase()
				return rows.filter((r) => (r.text || '').toLowerCase().includes(q) || String(r.seq).includes(q))
			}, [rows, searchQuery])
			const totalChars = react.useMemo(() => rows.reduce((a, r) => a + (r.chars || 0), 0), [rows])
			const span = startIdx !== null && endIdx !== null ? { lo: Math.min(startIdx, endIdx), hi: Math.max(startIdx, endIdx) } : null
			// timeline geometry: equal-width (per visible row) or proportional to chars
			const tlWidths = react.useMemo(() => {
				const n = filtered.length
				if (n === 0) return []
				if (equalWidth) {
					const w = 100 / n
					return filtered.map(() => w)
				}
				const total = filtered.reduce((a, r) => a + Math.max(1, r.chars || 0), 0)
				return filtered.map((r) => Math.max(1, (r.chars || 0) * 100 / total))
			}, [filtered, equalWidth])
			let tlLeft = 0
			const tlSpans = []
			for (let i = 0; i < filtered.length; i++) {
				const row = filtered[i]
				const w = tlWidths[i]
				const sel = span !== null && i >= span.lo && i <= span.hi
				tlSpans.push({ idx: i, row, left: tlLeft, width: w, selected: sel })
				tlLeft += w
			}
			// turn boundaries: vertical line between consecutive non-tool rows
			const turnBoundaries = []
			for (let i = 0; i < filtered.length - 1; i++) {
				if (!isToolRow(filtered[i]) && !isToolRow(filtered[i + 1])) turnBoundaries.push(tlSpans[i].left + tlSpans[i].width)
			}
			const detailRow = detailIdx !== null ? rows[detailIdx] : null
			const hasSelection = startIdx !== null && endIdx !== null
			const visibleRows = filtered.filter((row, i) => {
				if (isToolRow(row)) return !collapseTurns
				if (isToolCallOnly(row)) return !collapseCalls
				return true
			})
			const clockIcon = toolbarIcon('clock')
			const tbActions = [
				{ key: 'duration', pressed: equalWidth, title: equalWidth ? '等宽' : '按内容量', onClick: () => { setEqualWidth(!equalWidth); setStartIdx(null); setEndIdx(null) }, icon: clockIcon, label: equalWidth ? '等宽' : '耗时' },
				{ key: 'turns', pressed: collapseTurns, title: collapseTurns ? '展开工具行' : '折叠工具行', onClick: () => setCollapseTurns(!collapseTurns), label: collapseTurns ? '⊞' : '⊟', text: '轮次' },
				{ key: 'calls', pressed: collapseCalls, title: collapseCalls ? '展开工具调用' : '折叠工具调用', onClick: () => setCollapseCalls(!collapseCalls), label: collapseCalls ? '⊞' : '⊟', text: '调用' },
			]
			return react.createElement('div', { className: 'cx1root', 'data-conversation-composer-overlay': '' },
				// toolbar
				react.createElement('div', { className: 'cx1tbRoot', role: 'toolbar' },
					react.createElement('div', { className: 'cx1tbInner' },
						react.createElement('div', { className: 'cx1tbActions' },
							tbActions.map((a) => react.createElement('button', {
								key: a.key, className: 'cx1tbAction', type: 'button',
								'data-pressed': a.pressed, title: a.title, onClick: a.onClick,
							}, a.icon ? react.createElement('span', { className: 'cx1tbIcon', dangerouslySetInnerHTML: { __html: a.icon.body } }) : null, a.text || a.label)),
							react.createElement('button', { key: 'refresh', className: 'cx1tbAction', type: 'button', title: '刷新', onClick: handleRefresh }, '刷新'),
							react.createElement('button', { key: 'clear', className: 'cx1tbAction', type: 'button', title: '清除选择', disabled: !hasSelection, onClick: () => { setStartIdx(null); setEndIdx(null) } }, '清除选择'),
							react.createElement('button', { key: 'compress', className: 'cx1tbAction', type: 'button', 'data-primary': true, disabled: !hasSelection, onClick: handleCompress }, '压缩此区间'),
						),
						react.createElement('span', { className: 'cx1tbStats' }, rows.length + ' 条 · ' + totalChars + ' 字' + (rows.length ? ' · seq ' + rows[0].seq + '–' + rows[rows.length - 1].seq : '')),
						react.createElement('input', { className: 'cx1tbSearch', type: 'search', placeholder: '搜索', value: searchQuery, onChange: (e) => setSearchQuery(e.target.value) }),
					),
				),
				// timeline
				react.createElement('div', { className: 'cx1tlRoot', onMouseLeave: () => setHoverLeft(null) },
					react.createElement('div', { className: 'cx1tlPlot' },
						react.createElement('div', { className: 'cx1tlLabels' }, react.createElement('span', null, '输入'), react.createElement('span', null, '模型'), react.createElement('span', null, '工具')),
						react.createElement('div', { className: 'cx1tlTrack', onMouseMove: (e) => {
							const rect = e.currentTarget.getBoundingClientRect()
							if (rect.width > 0) setHoverLeft(Math.min(100, Math.max(0, (e.clientX - rect.left) * 100 / rect.width)))
						}, onClick: (e) => {
							const rect = e.currentTarget.getBoundingClientRect()
							if (rect.width === 0) return
							const x = (e.clientX - rect.left) * 100 / rect.width
							let best = null
							for (const s of tlSpans) {
								if (x >= s.left && x <= s.left + s.width) { best = s; break }
							}
							if (best) handleSelect(best.idx, best.row)
						} },
							react.createElement('div', { className: 'cx1tlLanes' },
								tlSpans.map((s) => react.createElement('div', {
									key: s.row.seq, className: 'cx1tlSpan',
									'data-timeline-span': rowKind(s.row.type),
									'data-selected': s.selected,
									'data-current': s.idx === startIdx || s.idx === endIdx,
									style: { left: 'calc(' + s.left + '% + 2px)', width: 'max(2px, calc(' + s.width + '% - 4px))', top: 'calc(var(--lane) * 14px)' },
								}))),
							span !== null ? react.createElement('div', { className: 'cx1tlSelection', style: { '--cx1-sel-left': tlSpans[span.lo].left + '%', '--cx1-sel-width': (tlSpans[span.hi].left + tlSpans[span.hi].width - tlSpans[span.lo].left) + '%' } }) : null,
							span !== null ? react.createElement('div', { className: 'cx1tlSelectionEdges', style: { '--cx1-sel-left': tlSpans[span.lo].left + '%', '--cx1-sel-width': (tlSpans[span.hi].left + tlSpans[span.hi].width - tlSpans[span.lo].left) + '%' } }) : null,
							hoverLeft !== null ? react.createElement('div', { className: 'cx1tlHoverLine', style: { '--cx1-hover-left': hoverLeft + '%' } }) : null,
							turnBoundaries.map((left, i) => react.createElement('div', { key: 'tb' + i, className: 'cx1tlTurnBoundary', style: { left: 'calc(' + left + '% - 0.5px)' } })),
						),
					),
				),
				// ledger: table + fixed detail
				react.createElement('div', { className: 'cx1ledger' },
					react.createElement('div', { className: 'cx1tblPane' },
						react.createElement('table', { className: 'cx1tbl' },
							react.createElement('tbody', null,
								error ? react.createElement('tr', null, react.createElement('td', { colSpan: 3, className: 'cx1tblErr' }, error))
									: loading && rows.length === 0 ? react.createElement('tr', null, react.createElement('td', { colSpan: 3, className: 'cx1tblEmpty' }, '加载中…'))
									: visibleRows.length === 0 ? react.createElement('tr', null, react.createElement('td', { colSpan: 3, className: 'cx1tblEmpty' }, rows.length === 0 ? '暂无 surface 消息' : '无匹配结果'))
									: visibleRows.map((row, vi) => {
										const globalIdx = rows.indexOf(row)
										const isStart = globalIdx === startIdx, isEnd = globalIdx === endIdx
										const inSpan = span !== null && globalIdx >= span.lo && globalIdx <= span.hi
										const label = isStart ? '起点' : isEnd ? '终点' : null
										return react.createElement('tr', {
											key: row.seq, className: 'cx1tblRow',
											'data-kind': rowKind(row.type),
											'data-selected': isStart || isEnd || inSpan,
											onClick: () => handleSelect(globalIdx, row),
										},
											react.createElement('td', { className: 'cx1tblSeq' },
												react.createElement('span', { className: 'cx1tblSeqBadge' }, row.seq),
												label ? react.createElement('span', { style: { marginLeft: 4, color: 'var(--dsw-alias-state-business-primary)' } }, label) : null,
											),
											react.createElement('td', null, react.createElement('span', { className: 'cx1tblKind', 'data-kind': rowKind(row.type) }, rowKind(row.type))),
											react.createElement('td', null,
												isToolRow(row) && toolCallName(row) !== null
													? react.createElement('div', { className: 'cx1tblToolCall' }, '[tool] ' + toolCallName(row) + ' · ' + (row.chars || 0) + ' 字')
													: react.createElement('div', { className: 'cx1tblText' }, row.text || ''),
											),
										)
									}),
							),
						),
					),
					react.createElement('div', { className: 'cx1det' },
						detailRow ? react.createElement(react.Fragment, null,
							react.createElement('div', { className: 'cx1detHeader' },
								react.createElement('span', { className: 'cx1detTitle' }, '详情 · seq ' + detailRow.seq),
								react.createElement('button', { className: 'cx1detClose', type: 'button', onClick: () => setDetailIdx(null) }, '×'),
							),
							react.createElement('div', { className: 'cx1detBody' },
								react.createElement('div', { className: 'cx1detMeta' },
									react.createElement('div', { className: 'cx1detMetaRow' }, react.createElement('b', null, '类型：'), rowKind(detailRow.type)),
									react.createElement('div', { className: 'cx1detMetaRow' }, react.createElement('b', null, '字符：'), String(detailRow.chars || 0)),
								),
								react.createElement('div', { className: 'cx1detSection' },
									react.createElement('div', { className: 'cx1detSectionTitle' }, '内容构成'),
									detailRow.blocks.map((b, bi) => react.createElement('div', { key: bi, className: 'cx1detBlock' },
										react.createElement('div', { className: 'cx1detBlockHead' },
											react.createElement('span', { className: 'cx1detBlockKind' }, b.label ? b.kind + ' · ' + b.label : b.kind),
											react.createElement('span', { className: 'cx1detBlockChars' }, String(b.chars || 0) + ' 字'),
										),
										react.createElement('div', { className: 'cx1detBlockBody', 'data-code': b.kind === 'tool-call' || b.kind === 'tool-result' }, b.text || ''),
									)),
								),
							),
						) : react.createElement('div', { className: 'cx1detBody' }, react.createElement('div', { className: 'cx1detPlaceholder' }, '点击工具行查看详情')),
					),
				),
			)
		}
		//#endregion

		//#region apply
		const inject = ["slots", "remote", "remote.ctxSurface"]
		async function apply(ctx) {
			await ctx.remote.$mount(TYPERT_REMOTE)
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "ctx-surface",
				order: 20,
				label: () => "上下文",
				inject: (sessionId) => ({
					readSurface: (request) => ctx.remote.ctxSurface.read(request),
				}),
			}, CtxSurfaceView))
			return () => {}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`

const bundle = head + zodCode + tail
writeFileSync(join(root, 'lib/client.js'), bundle)
console.log('lib/client.js written,', bundle.length, 'bytes')
