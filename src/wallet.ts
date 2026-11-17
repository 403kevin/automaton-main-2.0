import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

interface Blob {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function keyFrom(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, 32);
}

export function createWallet(masterKey: string): { address: `0x${string}`; ciphertext: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const ciphertext = encryptSecret(privateKey, masterKey);
  return { address: account.address, ciphertext };
}

export function encryptSecret(secret: string, masterKey: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(masterKey, salt), iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const blob: Blob = {
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(blob);
}

export function decryptSecret(ciphertext: string, masterKey: string): string {
  let blob: Blob;
  try {
    blob = JSON.parse(ciphertext) as Blob;
    const salt = Buffer.from(blob.salt, "base64");
    const iv = Buffer.from(blob.iv, "base64");
    const tag = Buffer.from(blob.tag, "base64");
    const data = Buffer.from(blob.data, "base64");
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(masterKey, salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt wallet.");
  }
}

export function decryptWalletKey(ciphertext: string, masterKey: string): `0x${string}` {
  const secret = decryptSecret(ciphertext, masterKey);
  if (!/^0x[a-fA-F0-9]{64}$/.test(secret)) {
    throw new Error("Unable to decrypt wallet.");
  }
  return secret as `0x${string}`;
}
