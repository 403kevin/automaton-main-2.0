import { DatabaseSync } from "node:sqlite";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { AppConfig } from "./config.js";
import { sweepWithGas } from "./gas.js";
import { redact } from "./redact.js";

export interface Transfer {
  from: string;
  to: string;
  units: bigint;
  txHash: string;
}

export type BalanceResult = { ok: true; units: bigint } | { ok: false; error: string };

export type SyncResult =
  | { ok: true; toBlock: bigint; transfers: Transfer[] }
  | { ok: false; error: string };

export interface MoveResult {
  ok: boolean;
  units: bigint;
  txHash?: string;
  error?: string;
}

export interface ChainPort {
  readonly mode: "dry-run" | "live";
  getBalance(address: string): Promise<BalanceResult>;
  /** Incoming USDC. A failed read must not be treated as zero or as death. */
  sync(address: string, fromBlock: bigint | null): Promise<SyncResult>;
  fund(address: string, units: bigint): Promise<void>;
  move(privateKey: `0x${string}`, to: Address, units: bigint): Promise<MoveResult>;
  transferBetween(from: string, to: string, units: bigint): Promise<MoveResult>;
  sweep(privateKey: `0x${string}`, to: Address): Promise<MoveResult>;
}

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

function safeNumber(units: bigint): number {
  if (units < 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount is outside the ledger's safe integer range.");
  }
  return Number(units);
}

export class DryRunChain implements ChainPort {
  readonly mode = "dry-run" as const;

  constructor(private readonly db: DatabaseSync) {}

  private read(address: string): bigint {
    const row = this.db.prepare("SELECT units FROM sim_balances WHERE address = ?").get(address.toLowerCase()) as
      | { units: number }
      | undefined;
    return BigInt(row?.units ?? 0);
  }

  private write(address: string, units: bigint): void {
    this.db
      .prepare(
        "INSERT INTO sim_balances (address, units) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET units = excluded.units",
      )
      .run(address.toLowerCase(), safeNumber(units));
  }

  async getBalance(address: string): Promise<BalanceResult> {
    return { ok: true, units: this.read(address) };
  }

  async sync(): Promise<SyncResult> {
    return { ok: true, toBlock: 0n, transfers: [] };
  }

  async fund(address: string, units: bigint): Promise<void> {
    this.write(address, this.read(address) + units);
  }

  async transferBetween(from: string, to: string, units: bigint): Promise<MoveResult> {
    const balance = this.read(from);
    if (balance < units) return { ok: false, units: 0n, error: "Simulated USDC balance is too low." };
    this.write(from, balance - units);
    this.write(to, this.read(to) + units);
    return { ok: true, units, txHash: `dry-${from.slice(2, 8)}-${to.slice(2, 6)}-${units.toString()}` };
  }

  async move(privateKey: `0x${string}`, to: Address, units: bigint): Promise<MoveResult> {
    const from = privateKeyToAccount(privateKey).address;
    return this.transferBetween(from, to, units);
  }

  async sweep(privateKey: `0x${string}`, to: Address): Promise<MoveResult> {
    const from = privateKeyToAccount(privateKey).address;
    const balance = this.read(from);
    if (balance === 0n) return { ok: true, units: 0n, txHash: "dry-sweep-empty" };
    return this.move(privateKey, to, balance);
  }
}

export class LiveChain implements ChainPort {
  readonly mode = "live" as const;
  private readonly publicClient;
  private readonly chain;

  constructor(private readonly config: AppConfig) {
    this.chain = config.network === "base" ? base : baseSepolia;
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(config.rpcUrl) });
  }

  async getBalance(address: string): Promise<BalanceResult> {
    try {
      const units = await this.publicClient.readContract({
        address: this.config.usdcAddress,
        abi: ERC20,
        functionName: "balanceOf",
        args: [address as Address],
      });
      return { ok: true, units };
    } catch (error) {
      return { ok: false, error: redact(error instanceof Error ? error.message : "RPC balance read failed") };
    }
  }

  async sync(address: string, fromBlock: bigint | null): Promise<SyncResult> {
    try {
      const current = await this.publicClient.getBlockNumber();
      const start = fromBlock === null ? (current > 2000n ? current - 2000n : 0n) : fromBlock + 1n;
      if (start > current) return { ok: true, toBlock: current, transfers: [] };
      const logs = await this.publicClient.getLogs({
        address: this.config.usdcAddress,
        event: TRANSFER_EVENT,
        args: { to: address as Address },
        fromBlock: start,
        toBlock: current,
      });
      const transfers: Transfer[] = logs.map((log) => ({
        from: String(log.args.from ?? ""),
        to: String(log.args.to ?? address),
        units: BigInt(log.args.value ?? 0),
        txHash: log.transactionHash ?? "",
      }));
      return { ok: true, toBlock: current, transfers: transfers.filter((item) => item.txHash && item.units > 0n) };
    } catch (error) {
      return { ok: false, error: redact(error instanceof Error ? error.message : "RPC log read failed") };
    }
  }

  async fund(): Promise<void> {
    throw new Error("Faucet funding is only available in dry-run mode.");
  }

  private wallet(privateKey: `0x${string}`) {
    const account = privateKeyToAccount(privateKey);
    return createWalletClient({ account, chain: this.chain, transport: http(this.config.rpcUrl) });
  }

  async transferBetween(): Promise<MoveResult> {
    return { ok: false, units: 0n, error: "Live transfers require a signed transaction." };
  }

  async move(privateKey: `0x${string}`, to: Address, units: bigint): Promise<MoveResult> {
    try {
      const hash = await this.wallet(privateKey).writeContract({
        address: this.config.usdcAddress,
        abi: ERC20,
        functionName: "transfer",
        args: [to, units],
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return { ok: false, units: 0n, error: "USDC transfer reverted." };
      return { ok: true, units, txHash: hash };
    } catch (error) {
      return { ok: false, units: 0n, error: redact(error instanceof Error ? error.message : "USDC transfer failed") };
    }
  }

  private async getEth(address: string): Promise<BalanceResult> {
    try {
      const wei = await this.publicClient.getBalance({ address: address as Address });
      return { ok: true, units: wei };
    } catch (error) {
      return { ok: false, error: redact(error instanceof Error ? error.message : "ETH balance read failed") };
    }
  }

  private async sendEth(to: Address, wei: bigint): Promise<MoveResult> {
    if (!this.config.gasFunderKey) return { ok: false, units: 0n, error: "GAS_FUNDER_PRIVATE_KEY is not set." };
    try {
      const account = privateKeyToAccount(this.config.gasFunderKey);
      const wallet = createWalletClient({ account, chain: this.chain, transport: http(this.config.rpcUrl) });
      const hash = await wallet.sendTransaction({ to, value: wei });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return { ok: false, units: 0n, error: "Gas top-up reverted." };
      return { ok: true, units: wei, txHash: hash };
    } catch (error) {
      return { ok: false, units: 0n, error: redact(error instanceof Error ? error.message : "Gas top-up failed") };
    }
  }

  async sweep(privateKey: `0x${string}`, to: Address): Promise<MoveResult> {
    const from = privateKeyToAccount(privateKey).address;
    return sweepWithGas({
      usdc: () => this.getBalance(from),
      eth: () => this.getEth(from),
      topUp: (wei) => this.sendEth(from, wei),
      transfer: (units) => this.move(privateKey, to, units),
      minWei: this.config.gasMinWei,
      topUpWei: this.config.gasTopUpWei,
      funder: Boolean(this.config.gasFunderKey),
    });
  }
}

export class FlakyChain implements ChainPort {
  readonly mode = "live" as const;
  constructor(private readonly error = "rpc unavailable") {}
  async getBalance(): Promise<BalanceResult> {
    return { ok: false, error: this.error };
  }
  async sync(): Promise<SyncResult> {
    return { ok: false, error: this.error };
  }
  async fund(): Promise<void> {
    throw new Error(this.error);
  }
  async move(): Promise<MoveResult> {
    return { ok: false, units: 0n, error: this.error };
  }
  async transferBetween(): Promise<MoveResult> {
    return { ok: false, units: 0n, error: this.error };
  }
  async sweep(): Promise<MoveResult> {
    return { ok: false, units: 0n, error: this.error };
  }
}
