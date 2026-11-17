import { randomBytes } from "node:crypto";

export function newId(prefix = ""): string {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}
