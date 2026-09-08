/* tslint:disable */
/* eslint-disable */

export function run_app(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly run_app: () => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h8d0ff60991ae408c: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hc82c1aece26fa21c: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9107af808e34ce73: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h52c811846d0d5cb6: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hedfa96da08953ff0: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h00e7f87e5f9aaeff: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf6ed6e81354de747: (a: number, b: number, c: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h0d1327e52164b75a: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha43b4585b6718719: (a: number, b: number, c: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h6d963bf6ef7355aa: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hc69f3094b0ac92f5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h65a7329c705e32fa: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h0bf053a5c7e31224: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha0f32bc481b6daee: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha10f13bfce46938b: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha1c82c19865961ff: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3ea6601adf24aac5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf38d526372fba3fa: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3fc8b394a361a4c9: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h5e8b613c34a00328: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hdb52dc2d28900068: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h70a4eb3540d499c5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h5cbcb41c76c43d1c: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
