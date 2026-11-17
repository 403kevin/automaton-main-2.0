import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { AppConfig } from "./config.js";
import { redact } from "./redact.js";
import {
  facilitatorSettleBody,
  interpretFacilitatorSettle,
  type AuthorizationMessage,
  type PaymentSettler,
} from "./x402.js";

const AUTHORIZATION_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

/**
 * Settles an EIP-3009 authorization and returns only after the transaction receipt succeeds.
 * Direct broadcast uses FACILITATOR_PRIVATE_KEY for gas. Otherwise the configured facilitator
 * broadcasts, and we still wait for the receipt before reporting success.
 */
export class LiveSettler implements PaymentSettler {
  constructor(private readonly config: AppConfig) {}

  async settle(message: AuthorizationMessage, signature: Hex): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    const direct = this.config.settlement === "direct" || (this.config.settlement === "auto" && Boolean(this.config.facilitatorKey));
    if (direct) {
      if (!this.config.facilitatorKey) return { ok: false, error: "X402_SETTLEMENT=direct requires FACILITATOR_PRIVATE_KEY." };
      const submitted = await this.broadcast(message, signature);
      if (!submitted.ok) return submitted;
      return this.confirm(submitted.txHash);
    }
    if (!this.config.facilitatorUrl) {
      return { ok: false, error: "Live x402 needs FACILITATOR_PRIVATE_KEY or X402_FACILITATOR_URL." };
    }
    const remote = await this.viaFacilitator(message, signature);
    if (!remote.ok) return remote;
    return this.confirm(remote.txHash);
  }

  private client() {
    const chain = this.config.network === "base" ? base : baseSepolia;
    return {
      chain,
      publicClient: createPublicClient({ chain, transport: http(this.config.rpcUrl) }),
    };
  }

  private async broadcast(message: AuthorizationMessage, signature: Hex): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    try {
      const { chain, publicClient } = this.client();
      const account = privateKeyToAccount(this.config.facilitatorKey as `0x${string}`);
      const wallet = createWalletClient({ account, chain, transport: http(this.config.rpcUrl) });
      const used = await publicClient.readContract({
        address: this.config.usdcAddress,
        abi: parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]),
        functionName: "authorizationState",
        args: [message.from, message.nonce],
      });
      if (used) return { ok: false, error: "This authorization nonce is already used on chain." };
      const hash = await wallet.writeContract({
        address: this.config.usdcAddress,
        abi: AUTHORIZATION_ABI,
        functionName: "transferWithAuthorization",
        args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, signature],
      });
      return { ok: true, txHash: hash };
    } catch (error) {
      return { ok: false, error: redact(error instanceof Error ? error.message : "Direct settlement failed.") };
    }
  }

  private async viaFacilitator(message: AuthorizationMessage, signature: Hex): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    try {
      const response = await fetch(`${this.config.facilitatorUrl.replace(/\/$/, "")}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          facilitatorSettleBody({
            config: this.config,
            message,
            signature,
            resource: `https://automaton.local/a/${message.to}`,
            description: "Automaton paid response",
          }),
        ),
      });
      const text = await response.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return { ok: false, error: `Facilitator returned non-JSON (${response.status}).` };
      }
      const interpreted = interpretFacilitatorSettle(body);
      if (interpreted.ok) return interpreted;
      const record = body && typeof body === "object" ? (body as { transaction?: string }) : {};
      if (record.transaction && /^0x[a-fA-F0-9]{64}$/.test(record.transaction)) {
        return { ok: true, txHash: record.transaction };
      }
      return { ok: false, error: interpreted.error };
    } catch (error) {
      return { ok: false, error: redact(error instanceof Error ? error.message : "Facilitator request failed.") };
    }
  }

  private async confirm(txHash: string): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    try {
      const { publicClient } = this.client();
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 90_000 });
      if (receipt.status !== "success") return { ok: false, error: "Settlement transaction reverted. The ledger was not credited." };
      return { ok: true, txHash };
    } catch (error) {
      return { ok: false, error: redact(error instanceof Error ? error.message : "Settlement receipt was not confirmed.") };
    }
  }
}
