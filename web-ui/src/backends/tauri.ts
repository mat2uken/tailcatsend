/** Tauri composition root. The native shell still needs to supply the adapter;
 * this module does not itself install Tauri commands or remote permissions. */
export { createBackend } from "../backend";
export type { BackendEvent, BackendSnapshot, PonletBackend } from "../backend";
