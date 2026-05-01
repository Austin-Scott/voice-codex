import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControllerImageManager, isPathInside } from "../src/server/controllerImages";
import type { AppConfig } from "../src/server/config";

const root = path.join(process.cwd(), "runtime", "controller-images-test");
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "image.png"), pngBytes);
  fs.writeFileSync(path.join(root, "project", "notes.txt"), "not an image");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ControllerImageManager", () => {
  it("creates a modal presentation for workspace images", async () => {
    const manager = new ControllerImageManager(createConfig(root));
    const request = await manager.createPresentation({
      thread: {
        id: "thread-1",
        name: "Thread 1",
        cwd: path.join(root, "project")
      },
      paths: ["image.png"],
      title: "Preview"
    });

    expect(request.title).toBe("Preview");
    expect(request.images).toHaveLength(1);
    expect(request.images[0].mimeType).toBe("image/png");
    expect(request.images[0].url).toMatch(/^\/api\/mcp-images\//);
    expect(manager.getImage(request.images[0].id)?.mimeType).toBe("image/png");
  });

  it("rejects paths outside the workspace root", async () => {
    const manager = new ControllerImageManager(createConfig(root));

    await expect(
      manager.createPresentation({
        thread: {
          id: "thread-1",
          name: "Thread 1",
          cwd: path.join(root, "project")
        },
        paths: [path.dirname(root)]
      })
    ).rejects.toThrow("outside the configured workspace root");
  });

  it("rejects non-image files", async () => {
    const manager = new ControllerImageManager(createConfig(root));

    await expect(
      manager.createPresentation({
        thread: {
          id: "thread-1",
          name: "Thread 1",
          cwd: path.join(root, "project")
        },
        paths: ["notes.txt"]
      })
    ).rejects.toThrow("Unsupported image type");
  });
});

describe("isPathInside", () => {
  it("accepts the root and child paths only", () => {
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, "project", "image.png"))).toBe(true);
    expect(isPathInside(root, path.dirname(root))).toBe(false);
  });
});

function createConfig(workspaceRoot: string): AppConfig {
  return {
    rootDir: process.cwd(),
    host: "127.0.0.1",
    port: 3000,
    codexBin: "codex",
    codexArgs: [],
    apiKeyPath: "",
    certDir: "",
    certPath: "",
    keyPath: "",
    realtimeModel: "gpt-realtime",
    realtimeVoice: "marin",
    transcriptionModel: "gpt-4o-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "marin",
    scrollbackLimit: 200000,
    workspaceRoot,
    mcpHost: "127.0.0.1",
    mcpPort: 0
  };
}
