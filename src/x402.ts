import { verifyTypedData, type Address, type Hex } from "viem";
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
  return {
    x402Version: 1,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network: input.config.network === "base" ? "base" : "base-sepolia",
        maxAmountRequired: input.amountUnits.toString(),
        resource: input.resource,
        description: input.description,
        mimeType: "text/plain",
        payTo: input.payTo,
        asset: input.config.usdcAddress,
        extra: { name: input.config.usdcName, version: input.config.usdcVersion },
      },
    ],
    disclosure: "This resource is offered by an AI agent, not a human.",
  };
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

export function parseDryPayment(header: string): DryPayment | undefined {
  const match = /^dryrun:(0x[a-fA-F0-9]{40}):(\d+):([a-zA-Z0-9_-]{8,80})$/.exec(header.trim());
  if (!match) return undefined;
  return { kind: "dry", from: match[1] as Address, units: BigInt(match[2]), nonce: match[3] };
}
