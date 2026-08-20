// Build lib/client.js for @mimichunterz/agent-compact (browser half of the
// "上下文" surface panel).
//
// Two layers, assembled here into one self-contained window.__ModuleLoader__
// bundle:
//   1. The React VIEW layer (src/client/*.tsx) — real TSX, esbuild-bundled
//      below with `react`/`react/jsx-runtime` marked external (the host
//      page's ClientModuleSystem provides those as seed words; see that
//      system's `makeRequire` in dsh-client-modules for why `require("react")`
//      resolves correctly once nested inside this file's `factory(require)`).
//   2. The Cordis WIRING layer ($mount/slots.register/apply) — kept as a
//      hand-written template because it is Cordis plumbing, not UI, and the
//      existing $mount-then-nested-plugin sequencing (see the `apply`
//      comment below) is a real ordering constraint worth keeping visible
//      and easy to audit, not something a bundler would express more
//      clearly.
//
// The typert Remote schema block is NOT hand-typed here — it is extracted
// verbatim from the tsc-compiled, compile-time-type-checked
// lib/typert.remote-client.js (see src/typert.remote-client.ts). zod 4.4.3
// itself is inlined by extracting the exact zod region from the shipped
// dsh-api-remotes client bundle, so the schema instances carry the same
// `_zod` marker the client typert registry validates.
//
// Loop: edit src/client/*.tsx or src/typert.remote-client.ts -> `npm run
// build` (tsc then this script) -> refresh page (or wait for HMR).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 0. derive the browser schema block from the tsc-compiled, type-checked
// lib/typert.remote-client.js — see that file's header. This mechanically
// extracts the exact `z.object({...})`/`z.union([...])`/etc. construction
// lines tsc emitted and rewrites `z.foo(` -> `foo(` because the browser
// bundle's zod factories are unprefixed locals extracted from the shipped
// dsh-api-remotes bundle in step 1 below, not `import { z } from 'zod'`.
const remoteClientPath = join(root, 'lib', 'typert.remote-client.js')
const remoteClientSrc = readFileSync(remoteClientPath, 'utf8')
const schemaStart = remoteClientSrc.indexOf('const request$schema')
const schemaEnd = remoteClientSrc.indexOf('export const TYPERT_REMOTE')
if (schemaStart < 0 || schemaEnd < 0 || schemaEnd <= schemaStart) throw new Error('schema extraction failed: markers not found in lib/typert.remote-client.js (run tsc first)')
const schemaBlock = remoteClientSrc
	.slice(schemaStart, schemaEnd)
	.split('\n')
	.filter((line) => !line.includes('assertEqual('))
	.join('\n')
	.replace(/\bz\./g, '')
	.replace(/\brequest\$schema\b/g, '_ctxSurface_read_request$schema')
	.replace(/\bblock\$schema\b/g, '_ctxSurface_read_block$schema')
	.replace(/\brow\$schema\b/g, '_ctxSurface_read_row$schema')
	.replace(/\bresult\$schema\b/g, '_ctxSurface_read_result$schema')
	.trim()
if (!schemaBlock.includes('_ctxSurface_read_result$schema')) throw new Error('schema extraction failed: result$schema rename missed')

// ---- 1. extract the inlined zod 4.4.3 region from dsh-api-remotes ----
const apiRemotesPath = '/Users/mimiczhang/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js'
const apiRemotes = readFileSync(apiRemotesPath, 'utf8').split('\n')
const zodStart = apiRemotes.findIndex((l) => l.includes('//#region') && l.includes('zod/v4/core/core.js'))
const schemasRegion = apiRemotes.findIndex((l) => l.includes('zod/v4/classic/schemas.js'))
const zodEnd = apiRemotes.findIndex((l, i) => i > schemasRegion && l.trim() === '//#endregion')
const zodCode = apiRemotes.slice(zodStart, zodEnd + 1).join('\n')
if (!zodCode.includes('function readonly')) throw new Error('zod extraction failed: missing readonly factory')

// ---- 2. esbuild the React view layer (src/client/entry.tsx) ----
// react/jsx-runtime stay external: the host page supplies them as platform
// seed words through the custom `require` this whole bundle receives, not
// through a real bundled copy — bundling our own React would create a
// second React instance and break hooks across the plugin boundary.
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

// ---- 3. head ----
const head = `window.__ModuleLoader__.load({
	id: "@mimichunterz/agent-compact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

// ---- 4. tail: typert descriptors + esbuild view bundle + apply ----
const tail = `
		//#region typert.remote-client (extracted from tsc-compiled, type-checked lib/typert.remote-client.js — see step 0 above)
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

		//#region ctx-surface view bundle (esbuild-compiled from src/client/entry.tsx — nested module/exports scope so it cannot collide with this file's own)
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
		// Top-level inject must NOT include remote.ctxSurface: this bundle is
		// the only provider of that namespace (it $mounts it in apply), so
		// declaring it at entry level would deadlock the boot sweep (pending
		// (waiting for service: remote.ctxSurface)). Instead the namespace is
		// mounted first, then consumed from a nested sub-plugin whose own
		// inject declares it — by then the namespace fiber is already ACTIVE,
		// so the sub-plugin's inject resolves immediately and its ctx passes
		// the reflect guard when readSurface touches ctx.remote.ctxSurface.
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
