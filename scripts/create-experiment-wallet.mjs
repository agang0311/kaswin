import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { PrivateKey, initSync } from "../node_modules/@onekeyfe/kaspa-wasm/kaspa.js";

initSync({ module: fs.readFileSync(path.resolve("node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin")) });

const walletDir = path.resolve("wallets");
const network = process.argv[2] ?? "testnet-12";
const walletPath = path.join(walletDir, `experiment-${network}.json`);

fs.mkdirSync(walletDir, { recursive: true });

if (fs.existsSync(walletPath)) {
  const existing = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  console.log(
    JSON.stringify(
      {
        address: existing.address,
        path: walletPath,
        reused: true
      },
      null,
      2
    )
  );
  process.exit(0);
}

let privateKey;
for (;;) {
  try {
    privateKey = new PrivateKey(randomBytes(32).toString("hex"));
    break;
  } catch {
    // Retry the vanishingly rare value outside the secp256k1 scalar range.
  }
}
const keypair = privateKey.toKeypair();
const wallet = {
  label: "Kaspa Raffle Static V0 experiment wallet",
  network,
  address: keypair.toAddress(network).toString(),
  publicKey: keypair.publicKey,
  privateKey: privateKey.toString(),
  createdAt: new Date().toISOString(),
  warning: "Experimental small-value wallet only. Do not commit or share this file."
};

fs.writeFileSync(walletPath, JSON.stringify(wallet, null, 2), { mode: 0o600 });

console.log(
  JSON.stringify(
    {
      address: wallet.address,
      path: walletPath,
      reused: false
    },
    null,
    2
  )
);
