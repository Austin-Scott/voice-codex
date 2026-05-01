import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CodexThreadSummary,
  ControllerImage,
  ImageModalRequest
} from "../shared/protocol.js";
import type { AppConfig } from "./config.js";

const MAX_IMAGE_REFERENCES = 120;
const MAX_IMAGES_PER_REQUEST = 12;

interface StoredImage extends ControllerImage {
  filePath: string;
}

const IMAGE_MIME_BY_EXT = new Map<string, string>([
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"]
]);

export class ControllerImageManager extends EventEmitter {
  private images = new Map<string, StoredImage>();

  constructor(private readonly config: AppConfig) {
    super();
  }

  async createPresentation(input: {
    thread: Pick<CodexThreadSummary, "id" | "name" | "cwd">;
    paths: string[];
    title?: string;
    caption?: string;
  }): Promise<ImageModalRequest> {
    const requestedPaths = input.paths.map((item) => item.trim()).filter(Boolean);
    if (requestedPaths.length === 0) {
      throw new Error("At least one image path is required");
    }
    if (requestedPaths.length > MAX_IMAGES_PER_REQUEST) {
      throw new Error(`At most ${MAX_IMAGES_PER_REQUEST} images can be shown at once`);
    }

    const images: StoredImage[] = [];
    for (const requestedPath of requestedPaths) {
      images.push(await this.resolveImage(input.thread, requestedPath));
    }

    for (const image of images) {
      this.images.set(image.id, image);
    }
    this.pruneImages();

    const request: ImageModalRequest = {
      id: randomUUID(),
      threadId: input.thread.id,
      threadName: input.thread.name,
      title: input.title?.trim().slice(0, 140) || undefined,
      caption: input.caption?.trim().slice(0, 1000) || undefined,
      images: images.map(toControllerImage),
      createdAt: new Date().toISOString()
    };

    this.emit("open", request);
    return request;
  }

  getImage(id: string): StoredImage | undefined {
    return this.images.get(id);
  }

  private async resolveImage(
    thread: Pick<CodexThreadSummary, "id" | "name" | "cwd">,
    requestedPath: string
  ): Promise<StoredImage> {
    const filePath = path.resolve(
      path.isAbsolute(requestedPath) ? requestedPath : path.join(thread.cwd, requestedPath)
    );
    if (!isPathInside(this.config.workspaceRoot, filePath)) {
      throw new Error(`Image path is outside the configured workspace root: ${requestedPath}`);
    }

    const stats = await fs.stat(filePath).catch(() => undefined);
    if (!stats?.isFile()) {
      throw new Error(`Image file not found: ${requestedPath}`);
    }

    const mimeType = await detectImageMime(filePath);
    if (!mimeType) {
      throw new Error(`Unsupported image type: ${requestedPath}`);
    }

    const id = randomUUID();
    return {
      id,
      threadId: thread.id,
      threadName: thread.name,
      name: path.basename(filePath),
      path: filePath,
      mimeType,
      url: `/api/mcp-images/${encodeURIComponent(id)}`,
      filePath
    };
  }

  private pruneImages(): void {
    const overflow = this.images.size - MAX_IMAGE_REFERENCES;
    if (overflow <= 0) {
      return;
    }

    for (const id of Array.from(this.images.keys()).slice(0, overflow)) {
      this.images.delete(id);
    }
  }
}

function toControllerImage(image: StoredImage): ControllerImage {
  return {
    id: image.id,
    threadId: image.threadId,
    threadName: image.threadName,
    name: image.name,
    path: image.path,
    mimeType: image.mimeType,
    url: image.url
  };
}

export function isPathInside(rootInput: string, targetInput: string): boolean {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function detectImageMime(filePath: string): Promise<string | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  const expected = IMAGE_MIME_BY_EXT.get(ext);
  if (!expected) {
    return undefined;
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    if (expected === "image/png") {
      return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ? expected
        : undefined;
    }
    if (expected === "image/jpeg") {
      return header[0] === 0xff && header[1] === 0xd8 ? expected : undefined;
    }
    if (expected === "image/gif") {
      const prefix = header.subarray(0, 6).toString("ascii");
      return prefix === "GIF87a" || prefix === "GIF89a" ? expected : undefined;
    }
    if (expected === "image/webp") {
      return header.subarray(0, 4).toString("ascii") === "RIFF" &&
        header.subarray(8, 12).toString("ascii") === "WEBP"
        ? expected
        : undefined;
    }
    if (expected === "image/svg+xml") {
      const text = (await fs.readFile(filePath, "utf8")).slice(0, 512).toLowerCase();
      return text.includes("<svg") ? expected : undefined;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
