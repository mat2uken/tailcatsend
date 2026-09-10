/** Browser composition root for the Rust WASM service. */
export { createBackend } from "../backend";
export type { BackendEvent, BackendSnapshot, PonletBackend } from "../backend";

let initialization: Promise<void> | undefined;

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

type GoConstructor = new () => GoRuntime;

function globalGo(): GoConstructor | undefined {
  return (globalThis as typeof globalThis & { Go?: GoConstructor }).Go;
}

async function loadScript(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to load ${url}`));
    document.head.append(script);
  });
}

async function loadTailcatBridge(): Promise<void> {
  if (window.__ponletBackend || (globalThis as { tailSendTailcat?: unknown }).tailSendTailcat) {
    return;
  }
  if (!globalGo()) {
    await loadScript("/assets/wasm_exec.js");
  }
  const Go = globalGo();
  if (!Go) {
    throw new Error("Go WebAssembly runtime is unavailable");
  }
  const go = new Go();
  const response = await fetch("/assets/tailcat.wasm.gz");
  if (!response.ok) {
    throw new Error(`Unable to load Tailcat WebAssembly (${response.status})`);
  }
  const compressed = await response.arrayBuffer();
  const bytes =
    "DecompressionStream" in globalThis
      ? await new Response(
          new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer()
      : await (async () => {
          const raw = await fetch("/assets/tailcat.wasm");
          if (!raw.ok) {
            throw new Error(`Unable to load uncompressed Tailcat WebAssembly (${raw.status})`);
          }
          return raw.arrayBuffer();
        })();
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  void go.run(instance);
  await new Promise<void>((resolve, reject) => {
    const deadline = window.setTimeout(
      () => reject(new Error("Tailcat WebAssembly startup timed out")),
      30_000,
    );
    const check = (): void => {
      if ((globalThis as { tailSendTailcat?: unknown }).tailSendTailcat) {
        window.clearTimeout(deadline);
        resolve();
      } else {
        window.setTimeout(check, 10);
      }
    };
    check();
  });
}

/**
 * Load the Rust service after the static UI has been parsed.  The Go Tailcat
 * bridge is still owned by the window, while the Rust service installs the
 * small adapter consumed by the shared VanJS UI.
 */
export function initializeBrowserBackend(): Promise<void> {
  if (window.__ponletBackend) {
    return Promise.resolve();
  }
  initialization ??= (async () => {
    await loadTailcatBridge();
    const moduleUrl = new URL("/wasm/tailsend_web.js", window.location.origin).href;
    const wasm = await import(/* @vite-ignore */ moduleUrl);
    await wasm.default();
    wasm.install_backend();
  })();
  return initialization;
}
