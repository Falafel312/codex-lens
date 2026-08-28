# Codex Lens for Even G2

Codex Lens lets an Even G2 and R1 owner use their own Codex account from the glasses. It supports newest-first Codex chats, complete paginated replies, push-to-talk voice prompts, and gesture-based text entry without typing on the phone.

## User setup

1. [Download Codex Lens Companion for Windows](https://github.com/Falafel312/codex-lens/releases/latest/download/Codex-Lens-Companion-Setup-0.2.1.exe).
2. Install it, select **Sign in to Codex**, and complete the official Codex sign-in in the browser.
3. Install **Codex Lens** from Even Hub and open it on the phone.
4. Tap **Scan companion QR** and allow camera access when Even Realities asks. The app uses live scanning when the phone WebView supports it and otherwise opens Even's native camera to read the one-time QR locally.
5. Put on the G2. Scroll and tap to browse or type; hold the R1 or temple to speak. Open **Settings** near the top of the chat list to choose Compact, Standard, or Large text.

The composer uses multi-tap input: swipe to select a letter group, tap repeatedly to cycle its letters, pause briefly to commit, double-tap to delete, and hold to send.

The companion must remain open while the glasses app is in use.

## Privacy and security

- OpenAI credentials remain in the user's normal local Codex installation.
- The QR secret creates an AES-256-GCM encrypted channel between the Even app and the desktop companion.
- The hosted relay routes encrypted envelopes and cannot decrypt prompts or responses.
- Pairing QR codes are one-time use, and relay sessions expire.
- Codex turns run with a read-only sandbox and interactive approvals disabled.

## Project layout

| Path | Purpose |
|---|---|
| `src/` | Even Hub phone/G2 application |
| `companion/` | Electron Windows companion and installer configuration |
| `relay/` | Small WebSocket/HTTPS relay and onboarding website |
| `server/codex-app-server.mjs` | Codex app-server protocol wrapper used by the companion |

## Development

```bash
npm install
npm run build
npm run pack

cd relay
npm install
npm test

cd ../companion
npm install
npm start
```

The public release package is built with `npm run pack`. The Windows installer is built with `npm run dist:win` from `companion/`.

This repository is source-available for inspection. No license is granted for redistribution or derivative commercial use unless one is added later.
