# q-gagarin

Upbit API Node.js playground for REST and WebSocket examples.

## Requirements

- nvm
- Node.js 22
- npm

## Setup

```bash
nvm use
npm install
```

## Scripts

```bash
npm run ticker
npm run ticker:ws
npm run triangles
npm run check
npm test
```

The default market is `KRW-BTC`. Override it with `UPBIT_MARKET`:

```bash
UPBIT_MARKET=KRW-ETH npm run ticker
UPBIT_MARKET=KRW-ETH npm run ticker:ws
```

These examples use Upbit public quotation APIs, so no API keys are required.

## Triangular Arbitrage Scanner

Run the read-only universe scanner:

```bash
npm run triangles
```

The scanner loads all Upbit markets dynamically, finds unique 3-asset triangles, builds exactly one canonical display cycle per triangle, fetches orderbook best bid/ask snapshots, and writes:

- `out/upbit-triangles.json`
- `out/upbit-canonical-cycles.json`
- `out/upbit-canonical-cycle-multipliers.csv`
- `out/upbit-canonical-cycle-multipliers.html`

By default, `netMultiplier` equals `grossMultiplier` because no fee is assumed. To include a taker fee:

```bash
UPBIT_TAKER_FEE_RATE=0.0005 npm run triangles
```

The scanner does not submit orders and does not plot reverse cycles.
