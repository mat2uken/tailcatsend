import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("generates a sorted manifest and a 64-byte P-256 signature", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ponlet-manifest-"));
  try {
    const index = Buffer.from("<!doctype html>");
    const script = Buffer.from('console.log("ok");');
    await writeFile(join(directory, "index.html"), index);
    await writeFile(join(directory, "assets.js"), script);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    await run(process.execPath, ["../scripts/write_web_update_manifest.mjs", directory], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PONLET_UPDATE_PRIVATE_KEY_PEM: privateKeyPem,
        PONLET_UPDATE_RELEASE_ID: "test-release",
        PONLET_UPDATE_REVISION: "7",
      },
    });

    const manifestBytes = await readFile(join(directory, "ponlet-manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    expect(manifest).toMatchObject({
      distribution: "web",
      release_id: "test-release",
      revision: 7,
      target: "browser",
    });
    expect(manifest.files.map(({ path }) => path)).toEqual(["assets.js", "index.html"]);
    expect(manifest.files.find(({ path }) => path === "index.html").sha256).toBe(
      createHash("sha256").update(index).digest("hex"),
    );

    const signature = Buffer.from(
      (await readFile(join(directory, "ponlet-manifest.sig"), "utf8")).trim(),
      "base64",
    );
    expect(signature.byteLength).toBe(64);
    expect(
      verify("sha256", manifestBytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("derives the browser update public key when only the signing secret is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ponlet-config-"));
  try {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const output = join(directory, "ponlet-update-config.js");
    await run(process.execPath, ["../scripts/write_web_update_config.mjs", output], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PONLET_UPDATE_PRIVATE_KEY_PEM: privateKeyPem,
        PONLET_UPDATE_MANIFEST_URL: "",
        PONLET_UPDATE_SIGNATURE_URL: "",
        PONLET_UPDATE_PUBLIC_KEY_JWK: "",
        PONLET_UPDATE_API_VERSION: "",
        PONLET_UPDATE_CURRENT_REVISION: "7",
        PONLET_UPDATE_DISTRIBUTION: "",
        PONLET_UPDATE_TARGET: "",
      },
    });
    const config = await readFile(output, "utf8");
    expect(config).toContain("./ponlet-manifest.json");
    expect(config).toContain('"currentRevision":7');
    expect(config).toContain('"crv":"P-256"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
