declare module "selfsigned" {
  export interface GenerateOptions {
    days?: number;
    keySize?: number;
    algorithm?: string;
    extensions?: Array<Record<string, unknown>>;
  }

  export interface GeneratedCertificate {
    private: string;
    cert: string;
  }

  export function generate(
    attrs?: Array<{ name: string; value: string }>,
    options?: GenerateOptions
  ): GeneratedCertificate;

  const selfsigned: { generate: typeof generate };
  export default selfsigned;
}
