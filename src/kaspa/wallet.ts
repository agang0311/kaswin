import { Keypair, PrivateKey } from "@onekeyfe/kaspa-wasm";
import { ensureKaspaWasmReady } from "./wasm";

export interface BrowserTestWallet {
  id: string;
  address: string;
  network: string;
  privateKey: string;
  publicKey: string;
  balanceSompi: bigint;
}

export async function createBrowserTestWallet(network: string): Promise<BrowserTestWallet> {
  await ensureKaspaWasmReady();

  const keypair = Keypair.random();
  const privateKey = keypair.privateKey;

  return {
    id: keypair.xOnlyPublicKey.slice(0, 16),
    address: keypair.toAddress(network).toString(),
    network,
    privateKey,
    publicKey: keypair.publicKey,
    balanceSompi: 0n
  };
}

export async function importBrowserTestWallet(privateKeyHex: string, network: string): Promise<BrowserTestWallet> {
  await ensureKaspaWasmReady();

  const privateKey = new PrivateKey(privateKeyHex.trim());
  const keypair = privateKey.toKeypair();

  return {
    id: keypair.xOnlyPublicKey.slice(0, 16),
    address: keypair.toAddress(network).toString(),
    network,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    balanceSompi: 0n
  };
}

export function withWalletBalance(wallet: BrowserTestWallet, balanceSompi: bigint): BrowserTestWallet {
  return {
    ...wallet,
    balanceSompi
  };
}
