/* tslint:disable */
/* eslint-disable */

export function run_app(): void;

/**
 * JS entry point for events that originate in index.html (file transfer
 * streams, app_end, ...). `params_json` is a JSON object of string /
 * number / bool values; malformed input is logged without params.
 */
export function telemetry_log_event(name: string, params_json: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly run_app: (a: number) => void;
    readonly telemetry_log_event: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_3307: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wasm_bindgen_func_elem_3300: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => void;
    readonly __wasm_bindgen_func_elem_7974: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_8462: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_3310: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_8462_24: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_3306: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_4: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_6: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5384: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5384_8: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_9: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5384_10: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_11: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5384_12: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_13: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5384_14: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_15: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_16: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5384_17: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3308_18: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_14365: (a: number, b: number) => void;
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
