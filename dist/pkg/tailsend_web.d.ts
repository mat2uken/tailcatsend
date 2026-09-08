/* tslint:disable */
/* eslint-disable */

export function run_app(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly run_app: (a: number) => void;
    readonly __wasm_bindgen_func_elem_32024: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wasm_bindgen_func_elem_32023: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => void;
    readonly __wasm_bindgen_func_elem_111982: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_56940: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_32022: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_111986: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_32025: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56945: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_32021: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56947: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_39183: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_39179: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_39180: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56942: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56944: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_39184: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_39182: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56946: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56941: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56939: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_39181: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56948: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_56943: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
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
