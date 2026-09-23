Track unresolved historical token prices and their date gaps while keeping the database authoritative for prices and recorded unresolved targets. Adapter development is deferred; this issue tracks evidence and follow-up work.

Investigation scope: 51 assets needed to explain the 726 original requests expected to remain unresolved after the completed local backfill. Treat its 316 successful results as filled for planning; verify the assumption after production runs. Pools blocked only by underlying prices are retained as dependency impact, not separate pricing tasks.

The local diagnostic snapshots are `docs/historical-pricing/unpriced-assets.investigation.json` and `docs/historical-pricing/unpriced-assets.json`. These JSON files are excluded from Git and are not a second canonical inventory; reconcile them against the database. The latter retains dependency impact records. Merge completed graph runs chronologically with `bun run inventory:historical --graph <graph.json> --inventory docs/historical-pricing/unpriced-assets.json --run <unique-id>`. Keep run hashes and root/dependency roles; candidate does not mean stored. Retryable errors and invalid data must remain distinct from missing observations.

Backfill delivery is related to #43 and #26. The current graph writer inserts only explicit manifest roots; saving every intermediate dependency from #43 remains separate work. Source coverage considerations are also tracked in #38.

- [ ] Publish the reviewed graph writer and runbook; supply the manifest separately as a run artifact.
- [ ] Team executes the reviewed backfill and verifies database/API coverage.
- [ ] Merge inventories from additional historical queries.
- [ ] Reconcile candidate observations with stored rows after each backfill.
- [ ] Investigate the six assets with no observed coverage when adapter work resumes.
- [ ] Investigate unusable zero-valued multiBTC provider observations separately.

# Expected gaps after backfill

Production backfill has the same outcome as this completed local dry run; verify after execution.

Expected outcome: 316 new original-target prices; 726 original targets remain unresolved (29 were already stored).

The list below contains only the 51 assets needed to address the remaining failures. Pools and wrappers blocked only by these assets are excluded. Each listed date remains unresolved by the local backfill. Dates resolved by that run and unused graph branches are omitted.

Historical research is context only. A price found by the separate wider scan does not count as a backfill success unless the local backfill actually resolved it. Those observations are retained as follow-up leads.

Gap positions apply only to the remaining dates: before the first known price, after the last known price, or interior (within the known date range, including its endpoints). Multiple labels describe different missing dates. No-known-history means no usable historical range was found; incomplete research makes these positions provisional.

| Asset | Chain | Address | Remaining dates | Gap position | Historical prices |
|---|---:|---|---:|---|---|
| dgnETH | 1 | 0x005f893ecd7bf9667195642f7649da8163e23658 | 58 | interior, after | Found in investigated history |
| HBTC | 1 | 0x0316eb71485b0ab14103307bf65a021042c6d380 | 29 | before, after | Found in investigated history |
| pxETH | 1 | 0x04c154b66cb340f3ae24111cc767e0184ed00cc6 | 1 | interior | Found in investigated history |
| wcUSDCv3 | 1 | 0x093c07787920eb34a0a0c7a09823510725aee4af | 16 | no-known-history | None found in investigated history |
| USD3 | 1 | 0x0d86883faf4ffd7aeb116390af37746f45b6f378 | 4 | interior | Found in investigated history |
| sCHF | 1 | 0x0f83287ff768d1c1e17a42f44d644d7f22e8ee1d | 11 | before | Found in investigated history |
| yETH | 1 | 0x1bed97cbc3c24a4fb5c069c6e311a967386131f7 | 8 | interior, after | Found in investigated history |
| ibCHF | 1 | 0x1cc481ce2bd2ec7bf67d1be64d4878b16078f309 | 10 | interior | Found in investigated history |
| sKRW | 1 | 0x269895a3df4d73b077fc823dd6da1b95f72aaf9b | 32 | before, interior | Found in investigated history |
| wcUSDCv3 | 1 | 0x27f2f159fe990ba83d57f39fd69661764bebf37a | 14 | no-known-history | None found in investigated history |
| TRYB | 1 | 0x2c537e5624e4af88a7ae4060c022609376c8d0eb | 1 | interior | Found in investigated history |
| ynLSDe | 1 | 0x35ec69a77b79c255e5d47d5a3bdbefefe342630c | 2 | before | Found in investigated history |
| dETH | 1 | 0x3d1e5cf16077f349e999d6b21a4f646e83cd90c5 | 16 | no-known-history | None found in investigated history |
| sdFXS | 1 | 0x402f878bdd1f5c66fdaf0fababcf74741b68ac36 | 3 | interior | Found in investigated history |
| dYFI | 1 | 0x41252e8691e964f7de35156b68493bab6797a275 | 3 | before, after | Found in investigated history |
| PUSd | 1 | 0x466a756e9a7401b5e2444a3fcb3c2c12fbea0a54 | 4 | after | Found in investigated history |
| ibJPY | 1 | 0x5555f75e3d5278082200fb451d1b6ba946d8e13b | 12 | before | Found in investigated history |
| reUSD | 1 | 0x57ab1e0003f623289cd798b1824be09a793e4bec | 13 | before | Found in investigated history |
| sUSD | 1 | 0x57ab1ec28d129707052df4df418d58a2d46d5f51 | 1 | after | Found in investigated history |
| DUSD | 1 | 0x5bc25f649fc4e26069ddf4cf4010f9f706c23831 | 15 | after | Found in investigated history |
| msETH | 1 | 0x64351fc9810adad17a690e4e1717df5e7e085160 | 5 | interior | Found in investigated history |
| multiBTC | 1 | 0x66eff5221ca926636224650fd3b9c497ff828f7d | 8 | after | Found in investigated history (research incomplete) |
| ibGBP | 1 | 0x69681f8fde45345c3870bcd5eaf4a05a60e7d227 | 40 | before, interior, after | Found in investigated history |
| Surge USDf-aGHO | 1 | 0x6c5972311191097d002e804a9bf97c96c54059ed | 13 | after | Found in investigated history |
| wcUSDCv3 | 1 | 0x7e1e077b289c0153b5cead9f264d66215341c9ab | 1 | no-known-history | None found in investigated history |
| oBTC | 1 | 0x8064d9ae6cdf087b1bcd5bdf3531bd5d8c537a68 | 16 | before | Found in investigated history |
| USDaf | 1 | 0x85e30b8b263bc64d94b827ed450f2edfee8579da | 131 | interior, after | Found in investigated history |
| rETH | 1 | 0x9559aaa82d9649c7a7b220e7c461d2e74c9a3593 | 6 | before | Found in investigated history |
| upYFI | 1 | 0x95710bde45c8d384a976cc58cc7a7e489576b098 | 2 | after | Found in investigated history |
| ibKRW | 1 | 0x95dfdc8161832e4ff7816ac4b6367ce201538253 | 36 | before, interior | Found in investigated history |
| sdYFI | 1 | 0x97983236be88107cc8998733ef73d8d969c52e37 | 4 | before, interior | Found in investigated history |
| sGBP | 1 | 0x97fe22e7341a0cd8db6f6c021a24dc8f4dad855f | 22 | before, interior | Found in investigated history |
| msUSD | 1 | 0xab5eb14c09d416f0ac63661e57edb7aecdb9befa | 24 | interior | Found in investigated history |
| CTR | 1 | 0xb3ad645db386d7f6d753b2b9c3f4b853da6890b8 | 2 | interior | Found in investigated history |
| bLUSD | 1 | 0xb9d7dddca9a4ac480991865efef82e01273f79c3 | 9 | no-known-history | None found in investigated history |
| zunETH | 1 | 0xc2e660c62f72c2ad35ace6db78a616215e2f2222 | 26 | no-known-history | None found in investigated history |
| sEUR | 1 | 0xd71ecff9342a5ced620049e616c5035f1db98620 | 27 | before | Found in investigated history |
| XAI | 1 | 0xd7c9f0e536dc865ae858b0c0453fe76d13c3beac | 5 | after | Found in investigated history |
| xETH | 1 | 0xe063f04f280c60aeca68b38341c2eecbec703ae2 | 3 | interior | Found in investigated history |
| mUSD | 1 | 0xe2f2a5c287993345a840db3b0845fbc70f5935a5 | 2 | interior | Found in investigated history |
| yPRISMA | 1 | 0xe3668873d944e4a949da05fc8bde419eff543882 | 23 | interior | Found in investigated history |
| JPEG | 1 | 0xe80c0cd204d654cebe8dd64a4857cab6be8345a3 | 7 | interior, after | Found in investigated history |
| clevCVX | 1 | 0xf05e58fcea29ab4da01a495140b349f8410ba904 | 2 | interior | Found in investigated history |
| sAUD | 1 | 0xf48e200eaf9906362bb1442fca31e0835773b8b4 | 7 | before | Found in investigated history |
| sJPY | 1 | 0xf6b1c627e95bfc3c1b4c9b825a032ff0fbf3e07d | 11 | before, interior | Found in investigated history |
| ibAUD | 1 | 0xfafdf0c4c1cb09d430bf88c75d88bb46dae09967 | 7 | before | Found in investigated history |
| yCRV | 1 | 0xfcc5c47be19d06bf83eb04298b026f81069ff65b | 21 | before, interior | Found in investigated history |
| sBTC | 1 | 0xfe18be6b3bd88a2d2a7f928d00292e7a9963cfc6 | 40 | before | Found in investigated history |
| ApeUSD | 1 | 0xff709449528b6fb6b88f557f7d93dece33bca78d | 1 | interior | Found in investigated history |
| coveYFI | 1 | 0xff71841eefca78a64421db28060855036765c248 | 9 | interior | Found in investigated history |
| 0x7ceb23fd6bc0add59e62ac25578270cff1b9f619 | 137 | 0x7ceb23fd6bc0add59e62ac25578270cff1b9f619 | 32 | interior | Found in investigated history |

The JSON report contains exact remaining dates and affected request identifiers. No production writes are implied by this projection.
