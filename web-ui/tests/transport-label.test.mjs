import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, transportLabel } from "../src/i18n.ts";

afterEach(() => {
  setLanguage("en");
});

describe("transport labels", () => {
  it("keeps every known path visible in English", () => {
    setLanguage("en");
    expect(transportLabel("direct-udp")).toBe("WireGuard UDP");
    expect(transportLabel("webrtc")).toBe("WebRTC DataChannel");
    expect(transportLabel("derp")).toBe("DERP relay");
    expect(transportLabel("unknown")).toBe("Checking path…");
  });

  it("translates relay and unknown paths in Japanese", () => {
    setLanguage("ja");
    expect(transportLabel("direct-udp")).toBe("WireGuard UDP");
    expect(transportLabel("webrtc")).toBe("WebRTC DataChannel");
    expect(transportLabel("derp")).toBe("DERPリレー");
    expect(transportLabel("unknown")).toBe("経路を確認中…");
  });
});
