# Amos Player

Dark media library with accounts, playlists, watch progress, embedded-player support, a Ghostery-powered service-worker adblocker, and a Render-ready Node/Postgres backend.

## Local run

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000`.

## Render deploy

1. Push this folder to a GitHub repository.
2. In Render, create a new Blueprint from the repository.
3. Render will read `render.yaml` and create the web service plus Postgres database.
4. The first database state is seeded from `data/store.json` if that file exists.

Use a private GitHub repository if `data/store.json` contains real accounts, admin PIN hashes, library data, or watch progress.
