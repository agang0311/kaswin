# Commitment Oracle

Run three independent instances under different operators, domains, private keys, and master secrets. A single operator cannot change the winner after the three commitments are stored in the round covenant.

```powershell
npm install
$env:RAFFLE_ORACLE_PRIVATE_KEY="<32-byte hex private key>"
$env:RAFFLE_ORACLE_MASTER_SECRET="<at least 32 bytes of independent hex entropy>"
$env:RAFFLE_ORACLE_PORT="8790"
$env:RAFFLE_ORACLE_CORS_ORIGIN="https://raffle.example"
npm start
```

Endpoints:

- `GET /health`
- `GET /commitments/{roundId}` returns `{ publicKey, commitment }`
- `GET /attestations/{roundId}?ticketRoot={hex}` returns the fixed seed and a Schnorr signature bound to the final ticket root

The seed is `HMAC-SHA256(masterSecret, "kaspa-raffle-v7:" || roundId)`. Losing the master secret prevents payout and leaves timeout refund as the recovery route. Do not run all three instances under one operator or infrastructure owner.

Security assumption: at least one of the three operators keeps its seed secret until ticket sales are fixed and does not collude with the other operators. The commitments prevent an operator from replacing its seed after round creation, but three colluding operators can still reveal all seeds early or withhold attestations.
