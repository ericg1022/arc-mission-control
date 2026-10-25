# ARC Mission Control

An independent fan-made quest planner for *ARC Raiders*: next-raid recommendations, a full quest log, a supplies checklist and marked objective maps. It's a static site (no build step) with optional Google sign-in and Firestore sync for progress.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The app shell and dialogs |
| `app.js` | UI, campaign state, local saves, backup/restore |
| `route-planner.js`, `route-seed.js` | Raid-route planning |
| `offline-resources.js` | Bundled quest, raid, materials and translation data (site version 60) |
| `objective-maps.js` | Objective → map marker data |
| `languages.js` | Display-language switching |
| `cloud-sync.js` | Firebase sign-in and Firestore sync |
| `firebase-config.js` | Your Firebase web config |
| `firestore.rules` | Security rules: each user can only access `users/{uid}` |
| `maps/`, `items/`, `flags/`, `fonts/`, `brand/` | Static assets |

## Firebase setup

1. In the Firebase console, open your project (or create one) and add a **Web app**. Copy its config into `firebase-config.js`.
2. **Authentication → Sign-in method:** enable **Google**.
3. **Authentication → Settings → Authorized domains:** add `ericg1022.github.io` (and any custom domain). `localhost` is there by default.
4. **Firestore Database:** create a database, then paste `firestore.rules` into the **Rules** tab and publish.

Until `firebase-config.js` is filled in, the site runs in guest mode with browser-only saves.

## Hosting on GitHub Pages

Settings → Pages → *Deploy from a branch* → `main` / root. GitHub Pages on a **private** repo needs a paid GitHub plan; otherwise make the repo public or host elsewhere (Firebase Hosting works too).

## Running locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly from disk works for guest mode, but sign-in needs a web server.

## How sync works

Progress is one JSON document per user at `users/{uid}` (`stateJson`, `clientUpdatedAt`, `clientId`, `updatedAt`). Every change saves to the browser immediately and pushes to Firestore after a short debounce. Open devices receive updates live. On sign-in, the account copy wins unless this browser has newer unsynced edits; a brand-new account is seeded from the browser's guest progress.
