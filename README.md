# ConsentCraft

A working local prototype of a collaborative comic studio, with a neobrutalist interface, flexible teams, private drafts, explicit version approvals, and dedicated public comic pages.

## Run

Use Node.js 24 and the committed npm lockfile.

```sh
npm ci
npm run dev
```

Open http://localhost:3000 and choose **Create your studio**. Sign up with an email and password or connect your Ethereum wallet. Every account starts empty: create a project, upload your own artwork, and invite your collaborators. Only comics published by users appear in the library.

```sh
npm run lint
npm run typecheck
npm run build
npm test
npm start
```

The integration test starts its own production server on port 3017, uses an isolated `.data/test-<uuid>` namespace, and stops that server on completion. Run the build before the test. The normal studio is never modified by integration tests.

## Working features

- Local account creation, password sign-in, hashed passwords, expiring HttpOnly session cookies, and sign-out.
- Optional Ethereum wallet sign-in using RainbowKit and SIWE, including domain checks, expiring nonces, signature verification, and replay rejection.
- Per-user dashboards, persistent project creation, search, and state filters.
- Teams with a variable number of contributors. Invitations target an email or wallet address, appear in the recipient’s Invitations page, expire after seven days, can be canceled, and can only be accepted once by the matching account. Duplicate active invitations are rejected.
- Four-panel editing with PNG/JPEG uploads, server-side image decoding and normalization, dialogue, image descriptions, ordering, preview, explicit save, and stale-revision rejection. The first uploaded panel supplies the cover; there is no sample-art fallback.
- Editable contributor roles, integer basis-point shares, and use terms.
- Review freezes a version and its team. Each member approves or revokes independently. Reopening the draft invalidates all approvals.
- Publication requires unanimous approval. Published comics have their own `/comics/[id]` reader page, credits, terms, sharing, and panel-by-panel reading.
- Searchable public comic library and project activity history.
- Responsive desktop/mobile layouts and keyboard-accessible native dialogs.

## Try collaboration

1. Create a normal account and a project.
2. In **Team & shares**, create an invitation for another person's email or wallet and copy its link. The app does not send email.
3. The collaborator signs in with the invited identity and opens **Invitations**, or opens the shared link in a separate browser profile, then accepts.
4. Add more collaborators as needed. The owner sets positive shares totaling 100%.
5. Upload four panels and add image descriptions. Save, then freeze the version under **Review & publish**.
6. Each contributor signs in and approves. Use **Refresh** to load another contributor's latest action.
7. The owner publishes once every contributor has approved. Share the comic's reader URL.

## Wallet configuration

Browser-injected wallets work without WalletConnect configuration. To enable the full WalletConnect wallet list, set your own `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in `.env.local` and restart. No third-party project ID is embedded in the code. Never put a private key or seed phrase in this application.

The automated tests use freshly generated disposable signing keys to test SIWE. A real browser-extension wallet signature still requires the user to complete that wallet's own approval screen.

## Storage and boundaries

Data lives in `.data/studio/studio.json` on the server machine. Uploaded artwork is resized by the browser, fully decoded and normalized on the server, stripped of metadata, and stored as image data in this file. Invalid image data, SVG sample paths, and images over 20 megapixels are rejected. The `.data` directory is ignored by Git. Back up that directory to preserve the workspace; it contains account hashes, sessions, private drafts, and uploaded artwork.

Upgrading from the sample-filled version archives its example comics and anonymous demo-account projects in `archivedDemoProjects` inside the same JSON file. Demo sessions are signed out. The archive preserves edits for manual recovery; it is not exposed through the API. Regular accounts and their projects stay active. New databases never seed demo content.

This is designed for one local Node server, with serialized file transactions and atomic file replacement. It is not a multi-process or serverless database. Different people must access the same running server to collaborate; a localhost URL on another computer refers to that person's own computer.

Local email accounts do not verify email ownership or support password recovery. Production use needs verified identity, rate limiting, CSRF/session hardening appropriate to the deployment, a durable database with migrations and access policies, object storage, operational monitoring, and a security review.

Wallet sign-in is authentication only. Approvals are recorded by the application. This prototype does not deploy a smart contract, mint NFTs, sell collectibles, distribute payments, pin IPFS content, or enforce copyright. Shares record the team's agreement; no earnings are simulated. Publication exposes the comic to anyone who can access this app and freezes it in the application.

## Code map

- `app/api/studio/route.ts`: authenticated API, invitation lifecycle, review and publication rules.
- `lib/store.ts`: local persistence, accounts, sessions, and transaction serialization.
- `components/consent-app.tsx`: studio, library, editor, reader, and account interfaces.
- `components/web3-provider.tsx`, `lib/wagmi.ts`: wallet and query providers.
- `app/design.css`, `app/features.css`, `app/responsive.css`: visual system and layouts.
- `lib/images.ts`: image validation, decoding, size limits, and metadata removal.
- `tests/integration.mjs`: isolated multi-user and wallet authentication integration checks.

## Specification decisions

User corrections supersede the attached specification: teams are dynamic, each published comic has a dedicated page, and the visual direction is neobrutalism. To deliver a self-contained working prototype without external credentials, this iteration uses local persistence and account approvals. Supabase, IPFS, and onchain approvals/payments remain separate integration work. Plain CSS replaces the scaffold's custom Tailwind compiler loader, which failed during the production build on this Windows environment.
