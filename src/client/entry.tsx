// esbuild entry for the ctx-surface panel's React view layer ONLY — no
// Cordis wiring here. scripts/build-client.mjs compiles this file with
// esbuild (react/react-dom/react/jsx-runtime marked external — the host
// page's ClientModuleSystem provides those as seed words) and inlines the
// resulting CJS chunk into the hand-assembled plugin bundle, which still
// owns $mount/slots.register/apply() as plain JS (see that script's header
// comment for why that half stays hand-written rather than esbuild output).
export { CtxSurfaceView } from './CtxSurfaceView.js'
export { CSS, CSS_TAG } from './styles.js'
