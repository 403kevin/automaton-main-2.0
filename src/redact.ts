const PRIVATE_KEY = /0x[a-fA-F0-9]{64}/g;
const OPENROUTER = /sk-or-[a-zA-Z0-9_-]+/g;

export function redact(value: string): string {
  return value.replace(PRIVATE_KEY, "0x[redacted]").replace(OPENROUTER, "sk-or-[redacted]");
}
