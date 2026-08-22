// 为 @mimichunterz/agent-compact 构建浏览器半边 bundle lib/client.js：
// 1. React 视图层（src/client/*.tsx）由 esbuild 打包，react 保持 external
//    （宿主页面通过 ClientModuleSystem 提供）；
// 2. Cordis 接线层（$mount/slots.register/apply）保持为手写模板。
// typert schema 块从 tsc 编译后的 lib/typert.remote-client.js 逐字提取；
// zod 4.4.3 从官方 dsh-api-remotes bundle 中提取内联。
// 修改后运行 `npm run build`（先 tsc 再本脚本）并刷新页面。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 0. 从 src/ctx-surface.ts 提取 wire schema 定义区段（源文件中注释必然
// 保留；schema 定义是纯 JS 表达式，tsc 不改写其内容），并把 `z.foo(` 改写成
// `foo(`（浏览器 bundle 的 zod 工厂是无前缀局部变量）----
const ctxSurfacePath = join(root, 'src', 'ctx-surface.ts')
const ctxSurfaceSrc = readFileSync(ctxSurfacePath, 'utf8')
const schemaStart = ctxSurfaceSrc.indexOf('export const request$schema')
const schemaEnd = ctxSurfaceSrc.indexOf('// ctx-surface wire schemas end', schemaStart)
if (schemaStart < 0 || schemaEnd < 0 || schemaEnd <= schemaStart) throw new Error('schema extraction failed: wire schema region not found in src/ctx-surface.ts')
const schemaBlock = ctxSurfaceSrc
	.slice(schemaStart, schemaEnd)
	.replace(/^export const /gm, 'const ')
	.replace(/\bz\./g, '')
	.replace(/\brequest\$schema\b/g, '_ctxSurface_read_request$schema')
	.replace(/\bblock\$schema\b/g, '_ctxSurface_read_block$schema')
	.replace(/\brow\$schema\b/g, '_ctxSurface_read_row$schema')
	.replace(/\bresult\$schema\b/g, '_ctxSurface_read_result$schema')
	.trim()
if (!schemaBlock.includes('_ctxSurface_read_result$schema')) throw new Error('schema extraction failed: result$schema rename missed')

// ---- 1. 从 dsh-api-remotes 提取内联的 zod 4.4.3 区段 ----
const apiRemotesPath = '/Users/mimiczhang/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js'
const apiRemotes = readFileSync(apiRemotesPath, 'utf8').split('\n')
const zodStart = apiRemotes.findIndex((l) => l.includes('//#region') && l.includes('zod/v4/core/core.js'))
const schemasRegion = apiRemotes.findIndex((l) => l.includes('zod/v4/classic/schemas.js'))
const zodEnd = apiRemotes.findIndex((l, i) => i > schemasRegion && l.trim() === '//#endregion')
const zodCode = apiRemotes.slice(zodStart, zodEnd + 1).join('\n')
if (!zodCode.includes('function readonly')) throw new Error('zod extraction failed: missing readonly factory')

// ---- 2. 用 esbuild 构建 React 视图层（src/client/entry.tsx）----
// react 保持 external：打包我们自己的 React 会创建第二个实例并破坏 hooks。
const viewBuild = esbuild.buildSync({
	entryPoints: [join(root, 'src/client/entry.tsx')],
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'browser',
	target: 'es2020',
	jsx: 'automatic',
	external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
	logLevel: 'silent',
})
if (viewBuild.errors.length > 0) throw new Error('esbuild failed:\n' + viewBuild.errors.map((e) => e.text).join('\n'))
const viewBundleCode = viewBuild.outputFiles[0].text

// ---- 3. 头部 ----
const head = `window.__ModuleLoader__.load({
	id: "@mimichunterz/agent-compact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

// ---- 4. 尾部：typert 描述符 + esbuild 视图 bundle + apply ----
const tail = `
		//#region ctx-surface wire schemas（自 lib/ctx-surface.js 提取）
		${schemaBlock}
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

		//#region ctx-surface 视图 bundle（esbuild 编译自 src/client/entry.tsx）
		const ctxSurfaceViewModule = (function () {
			var module = { exports: {} };
			var exports = module.exports;
${viewBundleCode}
			return module.exports;
		})();
		const CtxSurfaceView = ctxSurfaceViewModule.CtxSurfaceView;
		const CSS_TAG = ctxSurfaceViewModule.CSS_TAG;
		const CTX_SURFACE_CSS = ctxSurfaceViewModule.CSS;
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@mimichunterz/agent-compact";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CTX_SURFACE_CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region apply
		// 顶层 inject 不能包含 remote.ctxSurface（本 bundle 是唯一提供者，入口层
		// 声明会死锁启动）；改为先 $mount 命名空间，再从嵌套子插件中消费。
		const inject = ["slots", "remote"];
		async function apply(ctx) {
			await ctx.remote.$mount(TYPERT_REMOTE);
			await ctx.plugin({
				inject: ["slots", "remote", "remote.ctxSurface"],
				apply(sub) {
					sub.slots.inject("conversation.view", () => sub.slots.register({
						name: "conversation.view",
						id: "ctx-surface",
						order: 20,
						label: () => "上下文",
						inject: () => ({
							readSurface: (request) => sub.remote.ctxSurface.read(request),
						}),
					}, CtxSurfaceView));
				},
			});
			return () => {};
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
