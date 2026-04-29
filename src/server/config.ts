import path from "node:path";

export interface AppConfig {
  rootDir: string;
  host: string;
  port: number;
  codexBin: string;
  codexArgs: string[];
  apiKeyPath: string;
  certDir: string;
  certPath: string;
  keyPath: string;
  realtimeModel: string;
  realtimeVoice: string;
  transcriptionModel: string;
  scrollbackLimit: number;
}

export function loadConfig(): AppConfig {
  const rootDir = process.cwd();
  const certDir = process.env.VOICE_CODEX_CERT_DIR ?? path.join(rootDir, ".secrets", "certs");

  return {
    rootDir,
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? "3000"),
    codexBin: process.env.CODEX_BIN ?? "codex",
    codexArgs: splitArgs(process.env.CODEX_ARGS ?? ""),
    apiKeyPath:
      process.env.OPENAI_API_KEY_PATH ?? path.join(rootDir, ".secrets", "openai-api-key.txt"),
    certDir,
    certPath: process.env.VOICE_CODEX_CERT_PATH ?? path.join(certDir, "cert.pem"),
    keyPath: process.env.VOICE_CODEX_KEY_PATH ?? path.join(certDir, "key.pem"),
    realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime",
    realtimeVoice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe",
    scrollbackLimit: Number(process.env.VOICE_CODEX_SCROLLBACK_LIMIT ?? "200000")
  };
}

function splitArgs(value: string): string[] {
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}
