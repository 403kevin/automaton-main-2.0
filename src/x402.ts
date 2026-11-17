import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "./config.js";

export const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface AuthorizationMessage {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export function paymentRequirements(input: {
  config: AppConfig;
  payTo: Address;
  amountUnits: bigint;
  resource: string;
  description: string;
}): Record<string, unknown> {
  const accept = {
    scheme: "exact",
    network: caipNetwork(input.config),
    amount: input.amountUnits.toString(),
    asset: input.config.usdcAddress,
    payTo: input.payTo,
    maxTimeoutSeconds: 300,
    extra: { name: input.config.usdcName, version: input.config.usdcVersion },
  };
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: input.resource, description: input.description, mimeType: "text/plain" },
    accepts: [accept],
    disclosure: "This resource is offered by an AI agent, not a human.",
  };
}

export const PUBLIC_SEPOLIA_FACILITATOR = "https://x402.org/facilitator";
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** v2 HTTP header names. v1 used X-PAYMENT and X-PAYMENT-RESPONSE. */
export const X402_HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

export function caipNetwork(config: AppConfig): string {
  return config.network === "base" ? "eip155:8453" : "eip155:84532";
}

export function networkMatches(config: AppConfig, network: string): boolean {
  return network === caipNetwork(config);
}

export function encodeHeaderValue(body: unknown): string {
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

export function v2PaymentHeaders(signature: string): Record<string, string> {
  return { [X402_HEADERS.signature]: signature };
}

export function domainFor(config: AppConfig) {
  return {
    name: config.usdcName,
    version: config.usdcVersion,
    chainId: config.chainId,
    verifyingContract: config.usdcAddress,
  } as const;
}

export async function verifyAuthorization(
  config: AppConfig,
  message: AuthorizationMessage,
  signature: Hex,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (message.validBefore <= now) return { ok: false, error: "Authorization has expired." };
  if (message.validAfter > now) return { ok: false, error: "Authorization is not valid yet." };
  if (message.value <= 0n) return { ok: false, error: "Authorization value must be positive." };
  try {
    const valid = await verifyTypedData({
      address: message.from,
      domain: domainFor(config),
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature,
    });
    return valid ? { ok: true } : { ok: false, error: "Authorization signature does not match the payer." };
  } catch {
    return { ok: false, error: "Authorization signature could not be checked." };
  }
}

export interface DryPayment {
  kind: "dry";
  from: Address;
  units: bigint;
  nonce: string;
}

export async function signAuthorization(
  privateKey: `0x${string}`,
  config: AppConfig,
  message: AuthorizationMessage,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({
    domain: domainFor(config),
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
}

export function parseDryPayment(header: string): DryPayment | undefined {
  const match = /^dryrun:(0x[a-fA-F0-9]{40}):(\d+):([a-zA-Z0-9_-]{8,80})$/.exec(header.trim());
  if (!match) return undefined;
  return { kind: "dry", from: match[1] as Address, units: BigInt(match[2]), nonce: match[3] };
}

export interface ParsedX402 {
  message: AuthorizationMessage;
  signature: Hex;
  network: string;
}

export interface PaymentSettler {
  settle(message: AuthorizationMessage, signature: Hex): Promise<{ ok: true; txHash: string } | { ok: false; error: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function decodeHeader(header: string): unknown {
  const trimmed = header.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const json = Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(json);
}

export function parseX402Header(header: string): { ok: true; value: ParsedX402 } | { ok: false; error: string } {
  if (header.trim().startsWith("dryrun:")) return { ok: false, error: "Not an x402 payload." };
  let body: unknown;
  try {
    body = decodeHeader(header);
  } catch {
    return { ok: false, error: "PAYMENT-SIGNATURE is not valid JSON or base64 JSON." };
  }
  const root = asRecord(body);
  if (!root) return { ok: false, error: "Payment payload must be an object." };
  const payload = asRecord(root.payload) ?? root;
  const authorization = asRecord(payload.authorization);
  const signature = typeof payload.signature === "string" ? payload.signature : "";
  const network = typeof root.network === "string"
    ? root.network
    : typeof asRecord(root.accepted)?.network === "string"
      ? String(asRecord(root.accepted)?.network)
      : "";
  if (!authorization || !/^0x[a-fA-F0-9]+$/.test(signature)) {
    return { ok: false, error: "Payment payload is missing authorization or signature." };
  }
  const from = String(authorization.from ?? "");
  const to = String(authorization.to ?? "");
  const nonce = String(authorization.nonce ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(from) || !/^0x[a-fA-F0-9]{40}$/.test(to) || !/^0x[a-fA-F0-9]{64}$/.test(nonce)) {
    return { ok: false, error: "Authorization addresses or nonce are malformed." };
  }
  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(String(authorization.value ?? ""));
    validAfter = BigInt(String(authorization.validAfter ?? "0"));
    validBefore = BigInt(String(authorization.validBefore ?? ""));
  } catch {
    return { ok: false, error: "Authorization amounts are not integers." };
  }
  return {
    ok: true,
    value: {
      network,
      signature: signature as Hex,
      message: { from: from as Address, to: to as Address, value, validAfter, validBefore, nonce: nonce as Hex },
    },
  };
}

export function encodePaymentHeader(input: {
  config: AppConfig;
  message: AuthorizationMessage;
  signature: Hex;
  resource: string;
  description: string;
}): string {
  const requirements = paymentRequirements({
    config: input.config,
    payTo: input.message.to,
    amountUnits: input.message.value,
    resource: input.resource,
    description: input.description,
  });
  const accepted = (requirements.accepts as Record<string, unknown>[])[0];
  const payload = {
    x402Version: 2,
    resource: requirements.resource,
    accepted,
    payload: {
      signature: input.signature,
      authorization: {
        from: input.message.from,
        to: input.message.to,
        value: input.message.value.toString(),
        validAfter: input.message.validAfter.toString(),
        validBefore: input.message.validBefore.toString(),
        nonce: input.message.nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** A facilitator success without a transaction hash is not a confirmed settlement. */
export function interpretFacilitatorSettle(body: unknown): { ok: true; txHash: string } | { ok: false; error: string } {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "Facilitator returned an empty body." };
  const tx = typeof record.transaction === "string" ? record.transaction : "";
  if (record.success === true && /^0x[a-fA-F0-9]{64}$/.test(tx)) return { ok: true, txHash: tx };
  const reason = typeof record.errorReason === "string" ? record.errorReason : "Facilitator rejected the payment.";
  return { ok: false, error: reason };
}

export function facilitatorSettleBody(input: {
  config: AppConfig;
  message: AuthorizationMessage;
  signature: Hex;
  resource: string;
  description: string;
}): Record<string, unknown> {
  const header = encodePaymentHeader(input);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepted: Record<string, unknown>;
    payload: unknown;
    resource: unknown;
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: decoded.resource,
      accepted: decoded.accepted,
      payload: decoded.payload,
    },
    paymentRequirements: decoded.accepted,
  };
}
