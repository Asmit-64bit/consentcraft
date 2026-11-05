# ConsentCraft implementation status

## Implemented

- Dynamic contributor teams, authenticated private drafts, invitations by email or wallet, real uploads, exact integer shares, and persistent local storage.
- Solidity `ConsentCraft` using OpenZeppelin ERC-721, ReentrancyGuard, and integer Math.mulDiv accounting.
- Owner-namespaced project identifiers; immutable contributor order after first proposal; unique nonzero wallets and positive shares totaling 10000 basis points.
- Version-specific wallet consent and revocation. New proposals invalidate earlier approvals. Only unanimous consent permits the owner to mint once into contract escrow.
- Exact-value, one-time primary sale; safe NFT transfer; pull payments with the last contributor receiving the rounding remainder; independent withdrawals to a chosen recipient.
- Immutable review packages with canonical JSON, hashes of actual stored bytes, exact terms, panel hashes, metadata, wallets, price, and rounding recipient. Local content-addressed storage plus configurable server-side Pinata pinning and local backup.
- Wallet transaction simulation, gas quote, network switching, immediate browser transaction-hash persistence, receipt tracking, replacement callbacks, two confirmations, and contract-state reconciliation. Server endpoints cannot approve or mint for a user.
- Review/propose/approve/revoke/mint UI, dedicated public comic reader and purchase UI, Earnings with onchain balances and withdrawals, Ethereum configuration page.
- Local-chain deployment scripts, Sepolia deployment script, generated ABI, exact compiler version, optimizer settings, and Cancun EVM target.

## Verified

- Solidity tests: invalid shares/wallets, missing consent, stale versions and digests, roster changes, revocation, repeated mint/sale rejection, escrow, exact-price purchases, rounding, payment conservation, failed withdrawal isolation, reentrancy rejection, and withdrawals.
- Web3 acceptance test: five real local-EVM wallets; four contributors sign in, upload, freeze, propose, partially approve, revise, unanimously approve, mint, sell to a fifth wallet, and withdraw every allocation. Immutable file bytes and hashes are checked through HTTP.
- Account/invitation/upload integration tests remain isolated from the user's studio.

## External configuration still required

- A funded Sepolia deployment signer, Sepolia RPC, and Pinata JWT are not present in this workspace. No Sepolia transaction or public IPFS pin has been claimed or fabricated.
- A real browser wallet still needs the user's own signature/transaction confirmations. Automated transactions use disposable wallets on isolated Hardhat nodes.
- Hosting and a production multi-user database remain separate deployment work. File storage is designed for one Node server; Supabase is not installed or represented as active.

## Boundaries

- No mainnet deployment, administrator minting bypass, upgrade key, secondary marketplace, automatic royalties, refund, or post-mint delisting.
- Local chain history disappears when Hardhat restarts. Contract reads detect missing reviews; start a fresh project on the new local deployment rather than treating old approvals as valid.
- IPFS pinning code requires real credentials and has not been exercised against a live Pinata account. Content addressing does not guarantee indefinite availability.
- This is a tested hackathon implementation, not an independently audited production contract.
