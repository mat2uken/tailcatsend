/* tslint:disable */
/* eslint-disable */

export function run_app(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly run_app: () => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hd7ea921419bc3a67: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf549755e23016557: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf91b4afbb12111aa: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h3db16f3bf34843f0: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hb87c02f12e27ea47: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h816ba4fe2df486b5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h968c45eab0eb8605: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf7a437d16ef579f0: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h01c298c6357884dc: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__haa3e2deeed052784: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h68cf7159c16c81c6: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h7be0741fc1720eb3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__he4ac53abf037698b: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h57794209479f5efc: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h6f7c98df6ef86425: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf03a6adec76e59e8: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h78fb71fbd149b41c: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h42f1b84e58002892: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h002eef256def0cfd: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h44c8c422f1b662d6: (a: number, b: number) => void;
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
