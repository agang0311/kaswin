import { createHash, createHmac, webcrypto } from "node:crypto";
import http from "node:http";
import process from "node:process";
import * as secp from "@noble/secp256k1";

globalThis.crypto ??= webcrypto;

const privateKeyHex = String(process.env.RAFFLE_ORACLE_PRIVATE_KEY || "").trim().toLowerCase();
const masterSecretHex = String(process.env.RAFFLE_ORACLE_MASTER_SECRET || privateKeyHex).trim().toLowerCase();
const port = Number(process.env.RAFFLE_ORACLE_PORT || 8790);
const allowedOrigin = process.env.RAFFLE_ORACLE_CORS_ORIGIN || "*";

if (!/^[0-9a-f]{64}$/.test(privateKeyHex) || !secp.utils.isValidSecretKey(Buffer.from(privateKeyHex, "hex"))) {
  throw new Error("RAFFLE_ORACLE_PRIVATE_KEY must be a valid 32-byte secp256k1 private key.");
}
if (!/^[0-9a-f]{64,}$/.test(masterSecretHex)) {
  throw new Error("RAFFLE_ORACLE_MASTER_SECRET must contain at least 32 bytes of hex entropy.");
}

const privateKey = Buffer.from(privateKeyHex, "hex");
const masterSecret = Buffer.from(masterSecretHex, "hex");
const publicKey = Buffer.from(secp.schnorr.getPublicKey(privateKey)).toString("hex");

function seedForRound(roundId) {
  return createHmac("sha256", masterSecret).update(`kaspa-raffle-v7:${roundId}`, "utf8").digest();
}

function commitmentForSeed(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

function json(response, status, value) {
  response.writeHead(status, {
    "access-control-allow-origin": allowedOrigin,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": allowedOrigin, "access-control-allow-methods": "GET, OPTIONS" });
      response.end();
      return;
    }
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true, protocol: "kaspa-raffle-v7-three-commitment-oracles", publicKey });
      return;
    }
    const match = /^\/(commitments|attestations)\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "GET" || !match) {
      json(response, 404, { error: "Not found" });
      return;
    }
    const roundId = decodeURIComponent(match[2]);
    if (!roundId || roundId.length > 128) throw new Error("Invalid round id.");
    const seed = seedForRound(roundId);
    const commitment = commitmentForSeed(seed);
    if (match[1] === "commitments") {
      json(response, 200, { publicKey, commitment });
      return;
    }
    const ticketRoot = String(url.searchParams.get("ticketRoot") || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(ticketRoot)) throw new Error("ticketRoot must be 32 bytes of hex.");
    const message = createHash("sha256").update(Buffer.concat([Buffer.from(ticketRoot, "hex"), seed])).digest();
    const signature = Buffer.from(await secp.schnorr.signAsync(message, privateKey)).toString("hex");
    json(response, 200, { publicKey, commitment, seed: seed.toString("hex"), signature });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Oracle request failed." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Kaspa raffle commitment oracle listening on :${port}; public key ${publicKey}`);
});
