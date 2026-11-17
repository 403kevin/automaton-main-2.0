import fs from "node:fs";
import { DEFAULT_GENESIS } from "./genesis.js";

/** Live OpenRouter catalog on 2026-11-17 had no slug containing "heretic". This is the listed uncensored model. */
export const SOAK_MODEL = "cognitivecomputations/dolphin-mistral-24b-venice-edition";

export const SOAK_SEEDS = [
  { name: "mite", genesis: DEFAULT_GENESIS },
  { name: "keel", genesis: DEFAULT_GENESIS },
  { name: "wick", genesis: DEFAULT_GENESIS },
] as const;

export const SOAK_SEED_USD = "1.50";

export function loadEnvFile(file: string): Record<string, string> {
  const text = fs.readFileSync(file, "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
