/** Browser composition root. The Worker bootstrap still needs to supply the
 * adapter. A missing adapter displays an unavailable state. */
export { createBackend } from "../backend";
export type { BackendEvent, BackendSnapshot, PonletBackend } from "../backend";
