import fs from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";
import type { AppConfig } from "./config.js";

export interface HttpsMaterial {
  key: Buffer;
  cert: Buffer;
  generated: boolean;
}

export function ensureCertificate(config: AppConfig): HttpsMaterial {
  if (fs.existsSync(config.certPath) && fs.existsSync(config.keyPath)) {
    return {
      cert: fs.readFileSync(config.certPath),
      key: fs.readFileSync(config.keyPath),
      generated: false
    };
  }

  fs.mkdirSync(config.certDir, { recursive: true });

  const generated = selfsigned.generate(
    [{ name: "commonName", value: "voice-codex.local" }],
    {
      days: 365,
      keySize: 2048,
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
            { type: 7, ip: "::1" }
          ]
        }
      ]
    }
  );

  fs.writeFileSync(config.keyPath, generated.private, { mode: 0o600 });
  fs.writeFileSync(config.certPath, generated.cert, { mode: 0o600 });

  return {
    cert: Buffer.from(generated.cert),
    key: Buffer.from(generated.private),
    generated: true
  };
}

export function certificatePaths(config: AppConfig): string {
  return `${path.relative(config.rootDir, config.certPath)} and ${path.relative(
    config.rootDir,
    config.keyPath
  )}`;
}
