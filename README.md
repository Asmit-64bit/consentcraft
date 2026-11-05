# ConsentCraft

A collaborative comic studio with Solidity-enforced consent, ERC-721 collectibles, a fixed-price primary sale, and contributor withdrawals. The interface uses neobrutalism, teams are dynamic, and every minted comic has a dedicated reader page. New accounts and the library start empty.

## Run the complete local Web3 app

Use Node.js 24 and the committed npm lockfile. The repository `.npmrc` preserves the wallet stack's peer-resolution settings; required SIWE and Hardhat peers are explicit dependencies.

```sh
npm ci
npm run contracts:compile
```

Start the local Ethereum node in one terminal:

```sh
npm run chain
```

In another terminal:

```sh
npm run deploy:local
npm run dev
```

Open http://127.0.0.1:3000 and check **Ethereum** in the sidebar. The app reads the deployed address from `deployments/local.json`. The RPC is `http://127.0.0.1:8545`, chain ID `31337`. Local Hardhat wallets are disposable development accounts; never fund them on a public network. The node's logs are in `.data/local-chain.log`. Connect a development wallet using your wallet extension.

## Complete workflow

1. Create an account or sign in with your wallet. Email accounts can draft, but every contributor must link a wallet before review.
2. Create a project, upload four PNG/JPEG panels, and add image descriptions and optional dialogue.
3. Invite contributors by wallet or email. Recipients accept from **Invitations** or the shared link. The app does not send email.
4. Set roles, positive shares totaling 100%, exact test ETH price, and artwork use terms. The last listed contributor receives any wei rounding remainder.
5. Save. In **Review & publish**, consent to exposing the immutable review package and prepare it. Review the package links, then propose the version through your wallet.
6. Every contributor reviews and approves the same onchain version. The owner cannot mint with missing consent. Revoke approval before editing; a newly proposed version invalidates old approvals.
7. Once everyone agrees, the owner mints the ERC-721 into contract escrow. Its price, package, and shares cannot change after minting. There is no delisting or refund.
8. A collector opens the public comic page, reviews terms and gas, and buys for the exact test ETH price. The contract transfers the NFT and allocates proceeds.
9. Each creator opens **Earnings** and withdraws their allocation to their chosen wallet. A failed withdrawal does not block anyone else.

Every wallet action simulates before submission. Submitted hashes persist immediately in the browser, project transactions are recorded by the server, and completion waits for two confirmations. Refresh reconciles contract state. Keep pending hashes when an RPC is unavailable; never infer success from a button click.

## Test

```sh
npm run build
npm run lint
npm run typecheck
npm run contracts:test
npm test
npm run test:web3
```

The build compiles Solidity and regenerates `lib/contracts/abi.ts` before building Next.js. Contract artifacts are generated in `artifacts/`.

Contract tests use their own Hardhat node on port 8546. App tests use a production server on 3017. Full Web3 tests use ports 8547 and 3019, isolated `.data/web3-test-<uuid>` storage, four contributor wallets, and a separate collector. They exercise proposals, revision invalidation, minting, the sale, accounting, withdrawals, and immutable content hashes without touching the normal studio or its chain.

## Ethereum Sepolia and IPFS

The Solidity contract is deployable to Sepolia. In a **deployment-only shell**, supply `SEPOLIA_RPC_URL` and a `DEPLOYER_PRIVATE_KEY` funded with Sepolia test ETH, then run:

```sh
npm run contracts:compile
npm run deploy:sepolia
```

The script checks the chain ID, waits for two confirmations, and writes `deployments/sepolia.json`. It never deploys to mainnet. Do not place a deployer key in a web app environment file or browser setting.

Configure the web server using `.env.example`: `NEXT_PUBLIC_CHAIN_ID=11155111`, the deployed `NEXT_PUBLIC_CONSENTCRAFT_ADDRESS`, `EVM_RPC_URL`, a public `NEXT_PUBLIC_APP_URL`, and server-only `PINATA_JWT`. Rebuild after changing public variables. Sepolia package preparation refuses to use local file URLs: IPFS pinning must be configured. WalletConnect is optional; injected wallets work without a project ID.

No Sepolia deployment or live IPFS upload has been performed without the user's credentials and funded signer. Current implementation and verification boundaries are recorded in `IMPLEMENTATION_STATUS.md`.

## Data and integrity

Drafts, sessions, and account hashes live in `.data/studio/studio.json`. Files prepared for review are stored by SHA-256 under `.data/studio/content`, served through an immutable endpoint, and bound to the contract by Keccak-256 hashes of the actual bytes. JSON uses recursively sorted keys and UTF-8 encoding. IPFS mode pins those same bytes and retains a local backup. Metadata contains approved wallet credits, not account emails.

The published reader uses the frozen snapshot after a confirmed mint. The contract is authoritative for consent, versions, escrow ownership, sale state, and balances. The file store is for a single Node process; it is not a multi-process/serverless database. Back up `.data`. Email accounts do not verify email ownership or provide password recovery; wallet verification is required for the onchain workflow.

Old seeded examples and anonymous demo work are preserved in `archivedDemoProjects`, outside active workspaces and the public API. Regular accounts remain active. No sample comics, artificial approvals, fake receipts, or simulated earnings appear in the product.

## Code

- `contracts/ConsentCraft.sol`: consent, ERC-721 escrow, sale, and pull-payment accounting.
- `contract-tests/consentcraft.mjs`: adversarial contract tests on a real local EVM.
- `scripts/compile-contracts.mjs`, `scripts/deploy.mjs`: compiler, generated ABI, and network-checked deployment.
- `lib/contracts/server.ts`: immutable package preparation and confirmed-chain reconciliation.
- `lib/contracts/storage.ts`: canonical serialization, content-addressed files, and Pinata integration.
- `components/chain-controls.tsx`: wallet review, transaction lifecycle, purchase, earnings, and network screens.
- `app/api/studio/route.ts`: account authentication, private drafts, invites, and revision checks.
- `tests/web3-integration.mjs`: five-wallet, end-to-end acceptance flow.

The contract constrains its own minting and sale path. It does not establish authorship, prevent copying or minting elsewhere, or automatically transfer copyright. It is not independently audited; this build targets local Ethereum and Sepolia test ETH.
