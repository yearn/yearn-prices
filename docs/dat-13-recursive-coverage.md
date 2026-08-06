# DAT-13 recursive constituent pricing decisions

This report classifies every recursive constituent promoted by the DAT-5 schema 1.1.0 inventory and records the pricing decision used by yearn-prices. The cohort is fixed to the validated closed day **2026-08-04 at 23:59:59 UTC**: 74 targets total, split across Ethereum (48), Optimism (19), and Base (7). Of these, 58 are current and historical requirements; 16 are historical-only.

## Evidence and rules

- Token identity and readable interfaces were observed from archive RPC state at the latest block at or before EOD: Ethereum 25,684,999; Optimism 155,144,611; Base 49,549,326.
- Parent relationships and current/historical requirements come from the authoritative DAT-5 inventory registry at commit `371278d`.
- CoinGecko's full platform registry was matched by both chain and contract address. A provider mapping alone was not accepted: production-equivalent DefiLlama probes also had to return a positive observation at or before EOD within the configured six-hour window.
- Automatic stablecoin pegs, future/nearest observations, circular parent inference, incomplete pool NAV, and numeric zero placeholders remain forbidden.

Primary references: [ERC-4626 previewRedeem](https://eips.ethereum.org/EIPS/eip-4626), [YIP-88](https://docs.yearn.fi/contributing/governance/yips/yip-88), [Yearn stYFI deployment](https://github.com/yearn/stYFI/blob/master/deployment.json), [LiquidLockerRedemption source](https://github.com/yearn/stYFI/blob/master/contracts/LiquidLockerRedemption.vy), [Abracadabra omnichain MIM](https://dev.abracadabra.money/token-related/omnichain-mim), [Superchain token list](https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/optimism.tokenlist.json), and [CoinGecko Optimism MIM contract mapping](https://api.coingecko.com/api/v3/coins/optimistic-ethereum/contract/0xb153fb3d196a8eb25522705560ac152eeec57901).

Additional reviewed references: [YieldNest ynETH deployment](https://docs.yieldnest.finance/resources/deployment-addresses), [YieldNest ynETH source](https://github.com/yieldnest/yieldnest-eigenlayer-lrt/blob/main/src/ynETH.sol), [Reserve rgUSD RFC](https://forum.reserve.org/t/rfc-introducing-rgusd/649), [Reserve RToken redemption source](https://github.com/reserve-protocol/protocol/blob/master/contracts/p1/RToken.sol), and [Overnight contract addresses](https://docs.overnight.fi/advanced/contract-addresses).

## Prioritized implementation

1. Use standard ERC-4626 `previewRedeem(oneShare)` only when `convertToAssets(oneShare)` is unavailable. This recovers waDAI and stataEthDAI without assuming parity.
2. Re-run existing dependency-complete Balancer NAV topologically. The two wrapper recoveries can unlock three promoted BPTs; no BPT is priced from a partial constituent set.
3. Add the reviewed Optimism MIM provider alias. It remains `estimated` / `fallback`, and provider timestamp validation remains latest-at-or-before-EOD.
4. Price upYFI and coveYFI from their executable YIP-88 net redemption value. Read the exact-block fee, scale, enabled flag, remaining capacity, YFI liquidity, and the upYFI-to-supYFI ERC-4626 conversion; never substitute gross nominal parity.
5. Price ynETH from its exact-block share conversion into native ETH, with WETH as the recursive price dependency; do not assume ETH parity.
6. Price reviewed Reserve RTokens from the exact complete redemption basket only when the protocol is unfrozen, fully collateralized, and has one-token redemption capacity.
7. Retain explicit unsupported outcomes for all other targets until a historical market observation or deterministic on-chain conversion is documented.

## Asset-level classification

| Target | Symbol | Requirement | Mechanics | Immediate blocked parent(s) | Pricing provenance decision |
| --- | --- | --- | --- | --- | --- |
| `1:0x005f893ecd7bf9667195642f7649da8163e23658` | dgnETH | current + historical | market or lock token | `1:0x021cf6b7ebb8c8efcf21396eb4c94658976172c7`<br>`1:0x5ba541585d6297b756f08b7c61a7e37752123b4f` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x04bc0ab673d88ae9dbc9da2380cb6b79c4bca9ae` | yBUSD | current + historical | legacy wrapper | `1:0x3b3ac5386837dc563660fb6a0937dfaa5924333b` | Unsupported: historical share rate exists, but underlying BUSD has no acceptable EOD observation. |
| `1:0x098256c06ab24f5655c5506a6488781bd711c14b` | waDAI | historical | standard wrapper | `1:0x6667c6fa9f2b3fc1cc8d85320b62703d938e4385` | Derived: previewRedeem(one share) times dependency price; full input provenance required. |
| `1:0x09db87a538bd693e9d08544577d5ccfaa6373a48` | ynETH | current + historical | non-rebasing native-ETH share | `1:0x19b8524665abac613d82ece5d8347ba44c714bdd`<br>`1:0x1f59cc10c6360da918b0235c98e58008452816eb`<br>`1:0xd04e38dae7203f6ab49238ede14df7a5ba7da63e` | Derived: exact-block `convertToAssets(one share)` times the recursively resolved WETH price. |
| `1:0x09fd37d9aa613789c517e76df1c53aece2b60df4` | ebUSD | current + historical | market or lock token | `1:0xd25f2cc6819fbd34641712122397efbaf9b6a6e2` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x196f4727526ea7fb1e17b2071b3d8eaa38486988` | RSV | current + historical | market or lock token | `1:0xc2ee6b0334c261ed60c72f6054450b61b8f18e35` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x1cc481ce2bd2ec7bf67d1be64d4878b16078f309` | ibCHF | current + historical | market or lock token | `1:0x08cea8e5b4551722deb97113c139dd83c26c5398`<br>`1:0x9c2c8910f113181783c249d8f6aa41b51cde0f0c` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x2191df768ad71140f9f3e96c1e4407a4aa31d082` | cvgCVX | current + historical | market or lock token | `1:0xc50e191f703fb3160fc15d8b168a8c740fec3666` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x31429d1856ad1377a8a0079410b297e1a9e214c2` | ANGLE | historical | market or lock token | `1:0x48ff31bbbd8ab553ebe7cbd84e1ea3dba8f54957` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x34635280737b5bfe6c7dc2fc3065d60d66e78185` | cvxPrisma | historical | market or lock token | `1:0x3b21c2868b6028cfb38ff86127ef22e68d16d53b` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x35282d87011f87508d457f08252bc5bfa52e10a0` | ULTRA | historical | market or lock token | `1:0xc236bae6e35b3fb7335e1c35ca0862ce92bd5de3` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x3d1e5cf16077f349e999d6b21a4f646e83cd90c5` | dETH | current + historical | market or lock token | `1:0x7c0d189e1fecb124487226dcba3748bd758f98e4` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x402f878bdd1f5c66fdaf0fababcf74741b68ac36` | sdFXS | current + historical | market or lock token | `1:0x71c91b173984d3955f7756914bbf9a7332538595`<br>`1:0x8c524635d52bd7b1bd55e062303177a7d916c046` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x41252e8691e964f7de35156b68493bab6797a275` | dYFI | current + historical | market or lock token | `1:0xe8449f1495012ee18db7aa18cd5706b47e69627c` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x466a756e9a7401b5e2444a3fcb3c2c12fbea0a54` | PUSd | current + historical | market or lock token | `1:0xe60986759872393a8360a4a7abeab3a6e0ba7848` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x476ef9ac6d8673e220d0e8bc0a810c2dc6a2aa84` | USPD | historical | market or lock token | `1:0x06cf5f9b93e9fcfdb33d6b3791eb152567cd8d36` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x586aa273f262909eef8fa02d90ab65f5015e0516` | FIAT | historical | market or lock token | `1:0x178e029173417b1f9c8bc16dcec6f697bc323746` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x5e74c9036fb86bd7ecdcb084a0673efc32ea31cb` | sETH | current + historical | market or lock token | `1:0xa3d87fffce63b53e0d54faa1cc983b7eb0b74a9c` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x616e8bfa43f920657b3497dbf40d6b1a02d4608d` | auraBAL | current + historical | market or lock token | `1:0x3dd0843a028c86e0b760b1a76929d1c5ef93a2dd` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x6667c6fa9f2b3fc1cc8d85320b62703d938e4385` | bb-a-DAI | historical | Balancer BPT | `1:0xfebb0bbf162e64fb9d0dfe186e517d84c395f016` | Derived: existing complete Balancer Vault NAV after every wrapper/underlying dependency resolves. |
| `1:0x66eff5221ca926636224650fd3b9c497ff828f7d` | multiBTC | current + historical | market or lock token | `1:0x2863a328a0b7fc6040f11614fa0728587db8e353` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x69681f8fde45345c3870bcd5eaf4a05a60e7d227` | ibGBP | current + historical | market or lock token | `1:0x22cf19eb64226e0e1a79c69b345b31466fd273a7`<br>`1:0xd6ac1cb9019137a896343da59dde6d097f710538` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x699e04f98de2fc395a7dcbf36b48ec837a976490` | tacUSD | current + historical | market or lock token | `1:0x51f5466690978173f45270f57e06e25b0c888261` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3` | VEUR | historical | market or lock token | `1:0xf05cfb8b4382c69f3b451c5fb55210b232e0edfa` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x78da5799cf427fee11e9996982f4150ece7a99a7` | rgUSD | current + historical | deprecated Reserve RToken | `1:0x20bb4a325924917e3336753ba5350a84f70f392e`<br>`1:0x627c22bd39c69e65f749f6307430da881709941c`<br>`1:0x6fc7ea6ca8cd2759803eb78159c931a8ff5e0557`<br>`1:0xde73e407efc75edbafc5bcd62ebb1e7a9b38ebcd`<br>`1:0xdf9015472ea23e3bea6fbd6092915f9ed6980a99`<br>`1:0xf5a7906b41b858b66d3a7cbe167df1fb43ffe977` | Derived: exact complete Reserve redemption basket; exact-block unfrozen, full-collateralization, and one-token redemption-capacity checks required. |
| `1:0x836a808d4828586a69364065a1e064609f5078c7` | pETH | historical | market or lock token | `1:0x9848482da3ee3076165ce6497eda906e66bb85c5` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x8c0d76c9b18779665475f3e212d9ca1ed6a1a0e6` | zunUSD | historical | market or lock token | `1:0x8c24b3213fd851db80245fccc42c40b94ac9a745` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x95710bde45c8d384a976cc58cc7a7e489576b098` | upYFI | current + historical | 69,420:1 liquid locker, wrapped 1:1 into supYFI for redemption | `1:0x13120b7599ddf33782c748a847cc1d3c96387ecd` | Derived: exact-block YIP-88 net redemption into YFI after the decaying fee, with enabled status, wrapper availability, remaining capacity, and facility liquidity all required. |
| `1:0x96e61422b6a9ba0e068b6c5add4ffabc6a4aae27` | ibEUR | current + historical | market or lock token | `1:0x19b080fe1ffa0553469d20ca36219f17fcf03859`<br>`1:0x8682fbf0cbf312c891532ba9f1a91e44f81ad7df` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x97983236be88107cc8998733ef73d8d969c52e37` | sdYFI | current + historical | market or lock token | `1:0x79e281bc69a03dabccd66858c65ef6724e50aebe`<br>`1:0x852b90239c5034b5bb7a5e54ef1bef3ce3359cc8` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0x97effb790f2fbb701d88f89db4521348a2b77be8` | CVG | historical | market or lock token | `1:0x004c167d27ada24305b76d80762997fa6eb8d9b2` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xab846fb6c81370327e784ae7cbb6d6a6af6ff4bf` | PAL | current + historical | market or lock token | `1:0xbe4f3ad6c9458b901c81b734cb22d9eae9ad8b50` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xacdf0dba4b9839b96221a8487e9ca660a48212be` | hyUSD | current + historical | Reserve RToken | `1:0xc794c6a95f30d0ebf7b3bbe85e8a0a95c9e411c1` | Unsupported at EOD: the exact redemption basket is valid, but constituent `0x27F2...f37a` is unsupported; incomplete-basket pricing is forbidden. |
| `1:0xb9d7dddca9a4ac480991865efef82e01273f79c3` | bLUSD | current + historical | market or lock token | `1:0x5ca0313d44551e32e0d7a298ec024321c4bc59b4` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xbcb8b7fc9197feda75c101fa69d3211b5a30dcd9` | xFraxTempleLP | historical | market or lock token | `1:0xdadfd00a2bbeb1abc4936b1644a3033e1b653228` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xc2e660c62f72c2ad35ace6db78a616215e2f2222` | zunETH | current + historical | market or lock token | `1:0x17d964da2bd337cfeaed30a27c9ab6580676e730`<br>`1:0x3a65cbaebbfecbea5d0cb523ab56fdbda7ff9aaa` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xc443c15033fcb6cf72cc24f1bda0db070ddd9786` | bb-a-USD | historical | Balancer BPT | `1:0xc2b021133d1b0cf07dba696fd5dd89338428225b` | Derived: existing complete Balancer Vault NAV after every wrapper/underlying dependency resolves. |
| `1:0xc55126051b22ebb829d00368f4b12bde432de5da` | BTRFLY | current + historical | market or lock token | `1:0x7483dd57f6488b0e194a151c57df6ec85c00ace9` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xc56c2b7e71b54d38aab6d52e94a04cbfa8f604fa` | ZUSD | historical | market or lock token | `1:0x400d4c984779a747462e88373c3fe369ef9f5b50` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xc581b735a1688071a1746c968e0798d642ede491` | EURT | current + historical | Tether euro stablecoin | `1:0x3b6831c0077a1e44ed0a21841c3bc4dc11bce833`<br>`1:0x3fb78e61784c9c637d560ede23ad57ca1294c14a`<br>`1:0xb9446c4ef5ebe66268da6700d26f96273de3d571`<br>`1:0xfd5db7463a3ab53fd211b4af195c5bccc1a03890` | Unsupported at EOD: reviewed CoinGecko identity produced only a future observation and a prior observation outside the six-hour window; no euro peg is assumed. |
| `1:0xd7c9f0e536dc865ae858b0c0453fe76d13c3beac` | XAI | current + historical | market or lock token | `1:0x326290a1b0004eee78fa6ed4f1d8f4b2523ab669` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xdf574c24545e5ffecb9a659c229253d4111d87e1` | HUSD | current + historical | market or lock token | `1:0x5b5cfe992adac0c9d48e05854b2d91c73a003858` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xe80c0cd204d654cebe8dd64a4857cab6be8345a3` | JPEG | current + historical | market or lock token | `1:0x23e7817bc73645063fb2fa85c1d098effe84be90`<br>`1:0xda68f66fc0f10ee61048e70106df4bdb26baf595` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xeb708639e8e518b86a916db3685f90216b1c1c67` | stataEthDAI | historical | standard wrapper | `1:0xc443c15033fcb6cf72cc24f1bda0db070ddd9786` | Derived: previewRedeem(one share) times dependency price; full input provenance required. |
| `1:0xfa24a90a3f2bbe5feea92b95cd0d14ce709649f9` | bb-a-DAI | historical | Balancer BPT | `1:0xc443c15033fcb6cf72cc24f1bda0db070ddd9786` | Derived: existing complete Balancer Vault NAV after every wrapper/underlying dependency resolves. |
| `1:0xfafdf0c4c1cb09d430bf88c75d88bb46dae09967` | ibAUD | current + historical | market or lock token | `1:0x3f1b0278a9ee595635b61817630cc19de792f506`<br>`1:0x54c8ecf46a81496eeb0608bd3353388b5d7a2a33` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `1:0xfc0b1eef20e4c68b3dcf36c4537cfa7ce46ca70b` | USDC+ | current + historical | Reserve RToken | `1:0xfed2b54453f75634bcdaea5e5b11a3f99b9c28fa` | Unsupported at EOD: the exact redemption basket is valid, but constituent `0x093c...e4Af` is unsupported; incomplete-basket pricing is forbidden. |
| `1:0xff71841eefca78a64421db28060855036765c248` | coveYFI | current + historical | 1:1-denominated liquid locker | `1:0xa3f152837492340daaf201f4dfec6cd73a8a9760` | Derived: exact-block YIP-88 net redemption into YFI after the decaying fee, with enabled status, remaining capacity, and facility liquidity all required. |
| `10:0x00a35fd824c717879bf370e70ac6868b95870dfb` | IB | current + historical | market or lock token | `10:0xb545592e38b603f4a904a5260a6ffc538bfcb424` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x00e1724885473b63bce08a9f0a52f35b0979e35a` | OATH | current + historical | market or lock token | `10:0xc3439bc1a747e545887192d6b7f8be47f608473f` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x1db2466d9f5e10d7090e7152b68d62703a2245f0` | SONNE | current + historical | market or lock token | `10:0x4e60495550071693bc8bdffc40033d278157eac7` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x300d2c875c6fb8ce4bf5480b4d34b7c9ea8a33a4` | pxETH | current + historical | market or lock token | `10:0x112d7a717a617c25a91b1c261708cce6831474b4` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x3417e54a51924c225330f8770514ad5560b9098d` | RED | current + historical | market or lock token | `10:0x4e316557f63c2156eafdfec08f31df4957136203`<br>`10:0x7a7f1187c4710010db17d0a9ad3fce85e6ecd90a` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x50c5725949a6f0c72e6c4a641f24049a917db0cb` | LYRA | current + historical | market or lock token | `10:0xdb61f9b480f0a8b817811cfaa89a1c219c355224` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x5d47baba0d66083c52009271faf3f50dcc01023c` | UNIDX | current + historical | market or lock token | `10:0xc0a0adf5e3b07e383c2c1533b2f0878a3195c622`<br>`10:0xe39120b27e5bfec953524402c2e261763c76519e` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x73cb180bf0521828d8849bc8cf2b920918e23032` | USD+ | current + historical | retired Overnight rebasing stablecoin | `10:0x0b28c2e41058edc7d66c516c617b664ea86eec5d`<br>`10:0x667002f9dc61ebcba8ee1cbeb2ad04060388f223`<br>`10:0x844d7d2fca6786be7de6721aabdff6957ace73a0`<br>`10:0xd330841ef9527e3bd0abc28a230c7ca8dec9423b`<br>`10:0xd95e98fc33670dc033424e7aa0578d742d00f9c7` | Unsupported at EOD: supply was zero and token redemption was paused with zero availability; no $1 or USDC parity is assumed. |
| `10:0x7ae97042a4a0eb4d1eb370c34bfec71042a056b7` | UNLOCK | current + historical | market or lock token | `10:0x6e6046e9b5e3d90eac2abba610bca725834ca5b3` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x920cf626a271321c151d027030d5d08af699456b` | KWENTA | current + historical | market or lock token | `10:0x8f47041adbef5bf321c9f63a0660326614ab6b60` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0x970d50d09f3a656b43e11b0d45241a84e3a6e011` | DAI+ | current + historical | market or lock token | `10:0x667002f9dc61ebcba8ee1cbeb2ad04060388f223` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0xa50b23cdfb2ec7c590e84f403256f67ce6dffb84` | BLU | current + historical | market or lock token | `10:0x615b9dd61f1f9a80f5bcd33a53eb79c37b20addc` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0xb153fb3d196a8eb25522705560ac152eeec57901` | MIM | current + historical | market token | `10:0xb2791477da69dde9cd2986349f8855b8e2da7245` | Estimated fallback: reviewed chain-specific CoinGecko identity; latest provider observation must be at or before EOD. |
| `10:0xbfd291da8a403daaf7e5e9dc1ec0aceacd4848b9` | USX | current + historical | market or lock token | `10:0xed47e3ce6d9c05f562c469ab1bf1244cc697aa73` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0xc03b43d492d904406db2d7d57e67c7e8234ba752` | wUSDR | current + historical | market or lock token | `10:0x95a05d06decf8e1eb93ae09b612fbd342f2f9e2e` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0xca0e54b636db823847b29f506bffee743f57729d` | CHI | current + historical | market or lock token | `10:0x41cc89b91d0abe260f2cb53c1abda07b321e71df` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0xdb4ea87ff83eb1c80b8976fc47731da6a31d35e5` | wTBT | current + historical | market or lock token | `10:0x5e6e17f745ff620e87324b7c6ec672b5743bd0b4` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0xe405de8f52ba7559f9df3c368500b6e6ae6cee49` | sETH | current + historical | market or lock token | `10:0x5e5a37445fadeb71f23514ae7d675ffc644e5e5a`<br>`10:0x7bc5728bc2b59b45a58d9a576e2ffc5f0505b35e` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `10:0xfd389dc9533717239856190f42475d3f263a270d` | GRAIN | current + historical | market or lock token | `10:0xdc2b136a9c1fd2a0b9497bb8b11823c2fbf47ac4` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `8453:0x22a2488fe295047ba13bd8cccdbc8361dbd8cf7c` | SONNE | current + historical | market or lock token | `8453:0x554eca2a48136724294ce47fb7bfe9aadfcee3c6` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `8453:0x2c8d2fc58b80acb3b307c165af8f3ee296e6a271` | pHAM | current + historical | market or lock token | `8453:0x03ff264046b085450649a993cdd65dcdd01a893e` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `8453:0x3dd79d6bd927615787cc95f2c7a77c9ac1af26f4` | pwBLT | current + historical | market or lock token | `8453:0x03ff264046b085450649a993cdd65dcdd01a893e` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `8453:0x65a2508c429a6078a7bc2f7df81ab575bd9d9275` | DAI+ | current + historical | market or lock token | `8453:0x1b05e4e814b3431a48b8164c41eac834d9ce2da6` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `8453:0x6b4712ae9797c199edd44f897ca09bc57628a1cf` | UNIDX | current + historical | market or lock token | `8453:0xa819af1cc8abe618ea8abadeb464960f7451ceab` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `8453:0xf7a0dd3317535ec4f4d29adf9d620b3d8d5d5069` | stERN | current + historical | market or lock token | `8453:0x218f511431194b2c756d67a137de536bea74e498`<br>`8453:0x607363389331f4b2d1b955d009506a67c565d75e` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |
| `8453:0xff8adec2221f9f4d8dfbafa6b9a297d17603493d` | WELL | current + historical | market or lock token | `8453:0xffa3f8737c39e36dec4300b162c2153c67c8352f` | Unsupported: direct contract market miss and no reviewed at-or-before-EOD alias or deterministic conversion path. |

## Isolated verification

The preserved DAT-2 baseline in `codex_dat2_validation_20260805` was compared with a fresh run in `codex_dat13_validation_20260805`. Both used the authoritative 703-target inventory for exactly `2026-08-04T23:59:59Z`.

| Outcome | Before | After | Net |
| --- | ---: | ---: | ---: |
| Priced | 473 | 480 | +7 |
| Unsupported | 188 | 180 | -8 |
| Quarantined | 42 | 43 | +1 |

Six promoted constituents became priced: waDAI, stataEthDAI, three Balancer BPTs, and Optimism MIM. Five immediate parent targets became recoverable: the two promoted intermediate BPTs plus Ethereum pools `0xc2b021...` and `0xfebb0b...`, and Optimism pool `0xb27914...`. In total, nine previously non-priced asset targets became priced. The remaining 68 promoted constituents are explicitly unsupported.

Two unrelated Arbitrum targets that were priced in the baseline were quarantined in the fresh run after the archive RPC returned transient state errors. This explains why the net priced increase is seven rather than nine; it is environmental variance, not a DAT-13 pricing-method regression. The idempotency rerun inserted 0 targets, updated 0 metadata rows, processed 0 work items, and retained the same terminal counts.

### YIP-88 follow-up

User-supplied locker mechanics led to a reviewed YIP-88 redemption adapter and a second fresh isolated schema, `codex_dat13_yip88_validation_20260805`. At Ethereum block 25,684,999, both locker slots were enabled and the fee was exactly `88461538461538461` (8.8461538461538461%). The adapter valued one upYFI through its 1:1 ERC-4626 conversion into supYFI, then applied the 69,420 scale and net fee; it valued one coveYFI with scale 1 and the same net fee. Both paths had sufficient remaining capacity and YFI liquidity.

| Outcome | Initial DAT-13 | With YIP-88 | Increment |
| --- | ---: | ---: | ---: |
| Priced | 480 | 484 | +4 |
| Unsupported | 180 | 176 | -4 |
| Quarantined | 43 | 43 | 0 |

The exact new recoveries at `2026-08-04T23:59:59Z` were:

- upYFI `0x95710b...`: `$0.027713727244972088`, derived from net redemption into YFI;
- coveYFI `0xff7184...`: `$1,923.8869453461598`, derived from net redemption into YFI;
- upYFI/YFI Curve parent `0x13120b...`: `$0.02873320386268165`, derived only after both reserves were priceable;
- coveYFI/YFI Curve parent `0xa3f152...`: `$2,032.6074725455665`, derived only after both reserves were priceable.

Relative to the preserved DAT-2 baseline, the final outcome is 484 priced, 176 unsupported, and 43 quarantined: a net change of +11 priced, -12 unsupported, and +1 quarantined. Eight of the 74 promoted constituents are now priced and 66 remain unsupported. The YIP-88 idempotency rerun inserted 0 targets, updated 0 metadata rows, and processed 0 work items.

### User-evidence follow-up

The rgUSD, ynETH, EURT, and Optimism USD+ evidence led to a third fresh isolated schema, `codex_dat13_user_assets_validation_20260805`. The reusable Reserve adapter was also applied to the promoted hyUSD and USDC+ RTokens, but remained dependency-complete and failed closed when any redemption constituent was unavailable.

| Outcome | With YIP-88 | User-evidence follow-up | Increment |
| --- | ---: | ---: | ---: |
| Priced | 484 | 493 | +9 |
| Unsupported | 176 | 166 | -10 |
| Quarantined | 43 | 44 | +1 |

Two promoted constituents became priced:

- ynETH `0x09db87...`: `$2,023.5354588021619`, derived from `1.080340686311753659` native ETH per share and the WETH dependency;
- rgUSD `0x78da57...`: `$1.0011353066145032`, derived from the complete sDAI redemption basket.

Seven immediate parent targets became recoverable:

- ynETH Curve parents `0x19b852...` at `$4,391.068489842723` and `0xd04e38...` at `$1,931.6530428839806`;
- rgUSD Curve parents `0x20bb4a...` at `$0.9990678664823794`, `0x627c22...` at `$2.489153734426762`, `0x6fc7ea...` at `$1.0087548061730383`, `0xdf9015...` at `$1.005577904660927`, and `0xf5a790...` at `$0.9712874440797704`.

The remaining reviewed failures stayed semantically unavailable:

- hyUSD requires unsupported redemption constituent `0x27F2...f37a`;
- USDC+ requires unsupported redemption constituent `0x093c...e4Af`;
- EURT had no accepted at-or-before-EOD observation inside the six-hour window;
- Optimism USD+ had zero supply, paused token redemption, and zero redemption availability at EOD;
- ynETH parent `0x1f59cc...` still requires unsupported constituent `0x35Ec...630c`;
- rgUSD parent `0xde73e4...` was quarantined because the Curve LP token had no circulating supply.

Relative to the preserved DAT-2 baseline, the final outcome is 493 priced, 166 unsupported, and 44 quarantined: a net change of +20 priced, -22 unsupported, and +2 quarantined. Ten of the 74 promoted constituents are now priced and 64 remain unsupported. The final idempotency rerun inserted 0 targets, updated 0 metadata rows, and processed 0 work items.

## External dependency boundary

This 74-target cohort is limited to Ethereum, Optimism, and Base and does not itself require HyperEVM. The subsequent
readiness slice adds chain-999 registry and secret routing, schedules its two authoritative targets, and proves exact
historical RPC bracketing plus at-or-before-EOD direct market evidence. No wrapper adapter or peg assumption is used.
DAT-5 still needs to align the producer capability metadata after the consumer change is integrated.
