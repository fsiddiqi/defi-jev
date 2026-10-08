# Multi-chain research notes — DeFi liquidation bot (Morpho Blue / viem)

Research date: 2026-10-07 (live API/RPC checks performed this day). Environment:
the bot currently runs Base-only; `src/lib/morpho.ts` is already chain-agnostic
(caller picks the `PublicClient` + Morpho address), so widening is mostly
config/scanning work in `src/scan.ts` / `src/lib/*`.

Anything not directly verified is marked **UNCERTAIN**. Addresses that were
verified **on-chain today** (via `eth_call`/`eth_getCode` against live public
RPCs) are marked ✅.

---

## 1. Morpho Blue deployments (contracts + chain IDs)

Source: https://docs.morpho.org/developers/contracts/addresses/ (Morpho Blue
section). The main `Morpho` contract is the singleton used by
`idToMarketParams` / `market` / `position` (the exact ABI already in
`src/lib/morpho.ts` works unchanged on every chain).

| Chain | Chain ID | Morpho Blue contract |
|---|---|---|
| **Ethereum** | 1 | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` ✅ (bytecode present) |
| **Base** | 8453 | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` ✅ (bytecode present) |
| **OP Mainnet (Optimism)** | 10 | `0xce95AfbB8EA029495c66020883F87aaE8864AF92` ✅ (bytecode present) |
| Arbitrum | 42161 | `0x6c247b1F6182318877311737BaC0844bAa518F5e` ✅ (bytecode present) |
| Arc | 5042 | `0x34CD04070dD72b14E241112F6d83812Df5Af7fCD` |
| HyperEVM | 999 | `0x68e37dE8d93d3496ae143F2E900490f6280C57cD` |
| Katana | 747474 | `0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc` |
| Monad | 143 | `0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee` |
| Polygon (PolygonPOS) | 137 | `0x1bF0c2541F820E775182832f06c0B7Fc27A25f67` (docs; not re-verified on-chain today) |
| Robinhood Chain | 4663 | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` |
| Unichain | 130 | `0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A` |
| Stable | 988 | `0xa40103088A899514E3fe474cD3cc5bf811b1102e` |
| Tempo | 4217 | `0x10EE9AAC980A180dd4DcFc96C746d60B0EA88f97` |
| World Chain | 480 | `0xE741BC7c34758b4caE05062794E8Ae24978AF432` |

More deployments in the docs (0G, Abstract, Avalanche, Bitlayer, BNB, Camp, Celo,
Citrea, Cronos, Eden, Etherlink, Flare, Fraxtal, Gensyn, Gnosis, Hemi, Ink,
Injective, Kaia, Linea, Lisk, MegaETH, Mode, Morph, Pharos, Plasma, Plume, Rise,
Scroll, Sei, Soneium, Sonic, TAC, XDC, Zircuit …). Full table:
https://docs.morpho.org/developers/contracts/addresses/

Key facts:
- The vanity address `0xBBBB…FFCb` is used on **Ethereum AND Base only**. OP
  Mainnet uses a different address (`0xce95A…4AF92`). Do not assume the vanity
  address everywhere.
- Morpho Blue is deployed & optimized for the target chain's EVM version
  (Cancun); all chains above are post-Cancun EVMs.

---

## 2. Morpho API (`https://api.morpho.org/graphql`)

**Clarification:** `api.morpho.org/graphql` is Morpho's *API* (GraphQL + REST),
**not** a The-Graph hosted subgraph. It is multi-chain by design. A separate
per-chain subgraph repo exists (`morpho-org/morpho-blue-subgraph`,
https://github.com/morpho-org/morpho-blue-subgraph) but you don't need it.

Docs: https://docs.morpho.org/developers/api/get-started/ ,
https://docs.morpho.org/developers/api/morpho/ , GraphQL playground:
https://api.morpho.org/graphql

### Multi-chain — confirmed ✅ (live query today)
Yes. Lists + filters take `chainId_in`. The live `chains` query returns these
14 networks (id: network):

```
1 Ethereum · 8453 Base · 747474 Katana · 999 HyperEVM · 42161 Arbitrum One ·
137 Polygon · 130 Unichain · 10 OP Mainnet · 480 World Chain · 143 Monad ·
988 Stable · 4217 Tempo Mainnet · 4663 Robinhood Chain · 5042 Arc
```

### (a) Enumerating markets per chain
```graphql
query($where: MarketFilters) {
  markets(where: $where, first: 100, skip: 0) {
    items {
      chain { id network }
      marketId            # bytes32, matches idToMarketParams on-chain
      listed              # curated/listed flag (bot probably wants listed OR all + own filters)
      collateralAsset { address symbol decimals }
      loanAsset { address symbol decimals }
      oracle { address }
      irmAddress
      lltv
      state { blockNumber utilization supplyAssetsUsd borrowAssetsUsd fee }
    }
    pageInfo { count countTotal limit skip }
  }
}
# variables: { "where": { "chainId_in": [8453] } }
```
`MarketFilters` supports (introspection-verified): `search`, `selector_in`,
`listed`, `uniqueKey_in`, `loanAssetTags_in`, `collateralAssetTags_in`,
`oracleAddress_in`, `irmAddress_in`, **`chainId_in`**,
`collateralAssetAddress_in`, `loanAssetAddress_in`, `lltv_gte/lte`,
`borrowAssets_gte/lte`, `borrowAssetsUsd_gte/lte`, `supplyAssetsUsd_gte/lte`,
`utilization_gte/lte`, `fee_gte/lte`, etc. (Scalar `_in`/`_gte`/`_lte` style —
no raw arithmetic expressions.)

Live sample today: `chainId_in: [1, 8453, 10]` → **6151 markets total**.

### (b) Finding positions with healthFactor < 1 (or < 0.999)
```graphql
query($where: MarketPositionFilters) {
  marketPositions(where: $where, first: 100, skip: 0, orderBy: HealthFactor, orderDirection: Asc) {
    items {
      id                       # "<chainId>-<marketId>-<userAddress>"
      healthFactor              # Float; < 1 → liquidatable
      listed                    # market listed flag
      priceVariationToLiquidationPrice
      market { chain { id network } marketId collateralAsset { address symbol } loanAsset { address symbol } }
      user { address }
      state { supplyAssetsUsd borrowAssetsUsd collateralUsd }
    }
    pageInfo { count countTotal limit skip }
  }
}
# variables: { "where": { "chainId_in": [1, 8453, 10], "healthFactor_lte": 0.999 } }
```
`MarketPositionFilters` (introspection-verified): `search`, `marketUniqueKey_in`,
`marketListed`, `userAddress_in`, **`chainId_in`**, **`healthFactor_gte/lte`**,
`supplyShares_gte/lte`, `borrowShares_gte/lte`, `collateral_gte/lte`.

Field names for the position: `healthFactor` is a `Float`; the ordering enum is
`MarketPositionOrderBy` with values like `HealthFactor` (confirmed live; the
all-caps spellings like `HEALTH_FACTOR`/`CHAIN` do NOT exist). Order direction
enum is `Asc`/`Desc`.

Live sample today: `chainId_in: [1,8453,10], healthFactor_lte: 1.0` →
**1936 positions** (includes tiny/dust positions with HF=0 and HF on the order
of 1e-35 that have 0 collateral — filter on `state.borrowAssetsUsd`/dollar
threshold downstream, or only query `marketUniqueKey_in` for markets you care
about, which is the `listed`-style filtering).

### Pagination style
**Offset-based: `items` + `pageInfo { countTotal count limit skip }`**, with
`first` (limit) and `skip` args on every plural root. **No cursors.** Use
`skip += count` while `skip < countTotal`. (Introspection-verified:
`PaginatedMarkets`/`PaginatedMarketPositions` = `items` + `pageInfo`.)

### Rate limits / auth
- **No API key / no auth** required for the GraphQL endpoint.
- Standard rate limit: **750 requests/minute** → `429` with `Retry-After: 600`.
  Severe abuse (~20k req/hr) → long cooldowns. Docs recommend caching + light
  polling. https://docs.morpho.org/developers/api/get-started/
- Query complexity cap: **1,000,000** (per-query; returned in
  `extensions.complexity`). Trim selections; large history queries are the
  expensive ones. `numberOfResults` search param capped at [0, 1000].
- **No SLA** — docs explicitly say not to hard-depend on it for critical ops.
  Recommended fallback: read on-chain (the bot already re-verifies HF on-chain
  via `src/lib/morpho.ts` `loadMarketTruth` — correct pattern: use the API for
  candidate discovery, verify + simulate on-chain before liquidating).

---

## 3. Free public RPC endpoints (no API key)

All endpoints below were **tested live today** (2026-10-07) with
`eth_gasPrice` + `eth_getBlockByNumber` + `eth_gasPrice` etc. — ✅ = responded
OK this session, ✗ = failed this session (may be transient or intentionally
blocked; treat ✗/⚠ as "verify before relying on it"). These are free tiers;
none are suitable as your *only* infra for a race-sensitive liquidation bot —
expect throttling under burst eth_call load and fall back to a paid/keyed
provider or your own node for the liquidation broadcast path.

### Ethereum (1)
| Endpoint | This session | Note |
|---|---|---|
| `https://ethereum-rpc.publicnode.com` | ✅ | PublicNode free tier; usually generous but can rate-limit bursts (https://www.publicnode.com/). Good default for eth_call loads. |
| `https://eth.drpc.org` | ✅ | dRPC free tier — CU-based rate limiting per IP, effectively ~1 req/s class unless you get an account key (https://drpc.org/docs/howitworks/ratelimiting). |
| `https://rpc.ankr.com/eth` | ⚠ | Now requires an API key ("Unauthorized: You must authenticate…"); open gateway no longer free-tier-usable. |
| `https://eth.llamarpc.com` | ✗ | Returned non-JSON/HTML this session — do not rely on it. |
| `https://1rpc.io/eth` | ✗ | "usage limit reached" for heavy use; fine for light dev, unreliable for bursts. |

### Base (8453)
| Endpoint | This session | Note |
|---|---|---|
| `https://mainnet.base.org` (official) | ✅ | Layer-2 team official endpoint; will rate-limit aggressive bots, otherwise fine. |
| `https://base-rpc.publicnode.com` | ✅ | PublicNode; good default for scanning. |
| `https://base.drpc.org` | ✅ | dRPC free tier; CU throttling. |
| `https://base.llamarpc.com` | ⚠ | HTML error this session — do not rely on it. |
| `https://1rpc.io/base` | ✗ | Same as ETH: usage-limit blocked for sustained use. |

### Optimism (10)
| Endpoint | This session | Note |
|---|---|---|
| `https://mainnet.optimism.io` (official) | ✅ | OP team official endpoint. |
| `https://optimism-rpc.publicnode.com` | ✅ | PublicNode; good default. |
| `https://optimism.drpc.org` | ✅ | dRPC free tier. |
| `https://optimism.llamarpc.com` | ✗ | DNS failed this session — do not rely on it. |
| `https://1rpc.io/op` | ✗ | Usage limit blocked. |

### Others (if you widen further)
Arbitrum: `https://arbitrum-rpc.publicnode.com` (✅ tested live). Katana/HyperEVM/
Unichain/etc. free endpoints are lower-reliability; check chainlist.org and
validate live before relying on them. Practical takeaway for eth_call-heavy
workloads: **PublicNode (publicnode.com) + dRPC free tier as second**, with the
official L2 endpoint as third — and cache aggressively (the bot already caches
on-chain truth with TTL).

---

## 4. DEX venue addresses per chain

### Uniswap V3 factory (`getPool(address tokenA, address tokenB, uint24 fee)`)
Official source: https://docs.uniswap.org/deployments (Uniswap v3 → UniswapV3Factory
rows; also https://docs.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).
Canonical fee tiers: 100, 500, 3000, 10000 (any other fee returns 0x0).

| Chain | Chain ID | V3 Factory | V3 NonfungiblePositionManager |
|---|---|---|---|
| Ethereum | 1 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| Base | 8453 | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| Optimism | 10 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| Arbitrum | 42161 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| Polygon | 137 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| Unichain | 130 | `0x1F98400000000000000000000000000000000003` | `0x943e6e07a7E8E791dAFC44083e54041D743C46E9` |
| World Chain | 480 | `0x7a5028BDa40e7B173C278C5342087826455ea25a` | `0xec12a9F9a09f50550686363766Cc153D03c27b5e` |

### Aerodrome (Base) — V2-style `getPool(tokenA, tokenB, stable)` + Slipstream CL
Source: https://github.com/aerodrome-finance/contracts (deploy output
`script/constants/output/DeployCore-Base.json`) and
https://github.com/aerodrome-finance/slipstream (`DeployCL-Base.json`).

| Contract | Address |
|---|---|
| **PoolFactory** (classic V2-style, built-in stable/volatile) | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
| Router (V2, `addLiquidity`/`swap`) | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| **Slipstream CLFactory** (concentrated liquidity) | `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A` |
| Slipstream NonfungiblePositionManager | `0x827922686190790b37229fd06084350E74485b72` |

Classic `PoolFactory.getPool` — **two ABI overloads exist** (source:
`contracts/factories/PoolFactory.sol`):
```solidity
function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address); // fee 0=volatile, 1=stable, >1 => zero
```
Slipstream CLFactory exposes a **public mapping getter** (no method named
`getPool` with a fee arg):
```solidity
mapping(address => mapping(address => mapping(int24 => address))) public getPool;
// generated getter: getPool(address tokenA, address tokenB, int24 tickSpacing) returns (address)
```
You must know the tick spacing to find a pool (→ pass through the few live
spacings). Slipstream fee tiers are `tickSpacingToFee(tickSpacing)` (e.g.
tickSpacing 100 → 0.05%, 200 → 0.3%; larger spacings exist — exact set is
dynamic, read `tickSpacingToFee`/`tickSpacings()` on the factory). **UNCERTAIN**
on the full live spacing set — read it from the factory at runtime.

### Velodrome (Optimism) — same code family as Aerodrome
Sources: https://github.com/velodrome-finance/slipstream
(`script/constants/output/DeployCL-Optimism.json` + `script/constants/Optimism.json`),
https://optimistic.etherscan.io/address/0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a
(Pool Factory V2), https://docs.infraredtrading.com/learn/protocols/velodrome/deployments

| Contract | Address |
|---|---|
| **Pool Factory V2** (classic stable/volatile; same `getPool(address,address,bool)` ABI as Aerodrome) | `0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a` |
| Router V2 (defaultFactory = Pool Factory V2 above) | `0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858` |
| **CL Factory (current Slipstream)** | `0xe13Dd1fbA721Aa81a1826D9523AC9BC7d260c879` |
| CL NonfungiblePositionManager (current) | `0xf7f8ccce99Ca2896eC75D3A399D152dB96808399` |
| Legacy CL factory (still live) | `0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F` |
| Older CL factory generation | `0x548118C7E0B865C2CfA94D15EC86B666468ac758` (from aerodrome-finance/slipstream DeployCL-Optimism.json) |

Same SLIPSTREAM mapping getter (`getPool(tokenA, tokenB, tickSpacing)`) applies.
**UNCERTAIN**: exact CL factory "current vs legacy" liveness — query both
factories' `getPool` for a known pair (e.g. WETH/USDC) at runtime to pick.

### Other DEXes worth adding later (names only, no verification)
- **Base**: Uniswap V3 (above), Aerodrome (above); others worth noting:
  Moonwell/Solv are lending (n/a); swap aggregation matters more: Bebop,
  Odos, 1inch, Paraswap. **UNCERTAIN** on any additional Base AMM factory
  addresses — investigate PancakeSwap Base deployment before use.
- **Optimism**: KyberSwap Elastic (DMM), Uniswap V2 (factory
  `0x0c642ca12334a723B6dfC0b52c2A519C54A5D67b` on OP — **UNCERTAIN**, verify),
  Sushi V2, 1inch. 
- **Ethereum**: Uniswap V2 factory `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`,
  Curve (registries, per-pool), Balancer V2 Vault `0xBA12222222228d8Ba44595815875C5Dfc1fB7Cc` — well-known,
  in scope later if you want non-single-hop.

---

## 5. Token addresses (✅ all verified via `eth_call` today)

USDC is **natively 6 decimals on every one of these chains** (Ethereum included).

| Token | Ethereum (1) | Base (8453) | Optimism (10) |
|---|---|---|---|
| **USDC** (native) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (6) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6) | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` (6) |
| **USDC.e** (bridged, OP only) | — | — | `0x7F5c764cBc14f9669B88837ca1490cCa17c31607` (6) |
| **WETH** (wrapped native) | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (18) | `0x4200000000000000000000000000000000000006` (18) | `0x4200000000000000000000000000000000000006` (18) |
| **cbBTC** | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8) | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8) | **UNVERIFIED** — assumed same deterministic address; confirm before use |
| **USDS** | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` (18) | `0x820C137fa70C8691f0e44Dc420a5e53c168921Dc` (18) | not researched |
| Native (ETH) address for balances | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (convention) | same convention | same convention |

Notes:
- On Base and Optimism the native gas asset is ETH; wrapped native is the
  canonical `0x4200…0006` on both OP-Stack chains.
- On Optimism remember **USDC (native, `0x0b2C…Ff85`) vs USDC.e (bridged,
  `0x7F5c…1607`)** — both report `symbol() = "USDC"` and 6 decimals (verified),
  so disambiguate by address, not symbol.
- cbBTC listed as same address across chains; on-chain verify on OP before use
  (Coinbase typically keeps one canonical address per chain, but do not assume).

---

## 6. Gas cost reality (measured + realistic heads-up)

Measured live today (via `eth_gasPrice` and latest block `baseFeePerGas` from
PublicNode/dRPC/official endpoints):

| Chain | Base fee (gwei) | eth_gasPrice (gwei) | ~200k-gas tx cost |
|---|---|---|---|
| Ethereum | ~0.43 | ~0.43 | ≈ 0.000086 ETH ≈ **$0.22** |
| Base | ~0.005 | ~0.006 | ≈ 0.0000012 ETH ≈ **$0.003** |
| Optimism | ~0.001 | ~0.001 | ≈ 0.0000002 ETH ≈ **$0.0005** |

(ETH ≈ $2,566 USD per CoinGecko simple/price API, fetched today.)

But **do not size the gas budget off today's idle mempool**. Historical/typical
peak gwei used by live liquidation bots (2024–2026; treat as informed estimates,
**UNCERTAIN** as forecasts):

| Chain | Typical quiet | Peak/panic blocks | 200k-gas peak cost |
|---|---|---|---|
| Ethereum | ~2–10 gwei | 30–150 gwei | **$10–$77** at $2,566/ETH |
| Base | 0.01–0.1 gwei | ~1 gwei (brief spikes) | ≤ $0.5 |
| Optimism | 0.001–0.01 gwei | ~0.05 gwei | ≤ $0.03 |

Budget guidance:
- **Ethereum**: worst-case per-attempt budget of **~$100** (≈ 0.04 ETH @ 150 gwei
  × 200k gas) if you must win under congestion; typical run-rate pennies.
- **Base / Optimism**: sub-cent to sub-dollar; the EIP-1559 base fee on both L2s
  is tiny, so ~everything is tip/priority-fee driven (Base fee market behaves
  EIP-1559-with-large-gap; OP uses 0-bid blocks when calm).
- Recompute gas caps as ETH price and fee regime drift — sample
  `eth_gasPrice` + last-N-block `baseFeePerGas` per chain at runtime rather than
  hard-coding gwei caps; keep a `maxFeePerGas` cap per chain in config.

---

## Sources
- Morpho addresses: https://docs.morpho.org/developers/contracts/addresses/
- Morpho API docs: https://docs.morpho.org/developers/api/get-started/ , https://docs.morpho.org/developers/api/morpho/
- Morpho GraphQL live tests (introspection + queries) run against https://api.morpho.org/graphql
- Morpho subgraph repo: https://github.com/morpho-org/morpho-blue-subgraph
- Uniswap deployments: https://docs.uniswap.org/deployments ; ETH v3: https://docs.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
- Aerodrome contracts: https://github.com/aerodrome-finance/contracts ; Slipstream: https://github.com/aerodrome-finance/slipstream
- Velodrome Slipstream: https://github.com/velodrome-finance/slipstream ; V2 factory on OP explorer: https://optimistic.etherscan.io/address/0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a
- RPC notes: https://www.publicnode.com/ , https://drpc.org/docs/howitworks/ratelimiting , https://chainlist.org
- On-chain token/gas/RPC checks: live `eth_call`/`eth_getCode`/`eth_gasPrice` this session.