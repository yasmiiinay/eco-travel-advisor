# Deployment guide

The assistant ships as a **single Docker image** that runs the whole stack behind one
port. The same image is used for local Docker runs and for the public deployment on
**Hugging Face Spaces** — there is nothing extra to configure for the cloud host.

## What is inside the image

```
            ┌──────────────────────── container (port 7860) ────────────────────────┐
            │                                                                        │
  browser ──┼──▶ nginx ──▶ /                       → static web UI (frontend/)       │
            │         └──▶ /webhooks  /conversations → Rasa REST server  (:5005) ──┐  │
            │                                                              │        │  │
            │                                          custom action server (:5055)◀┘  │
            └────────────────────────────────────────────────────────────────────────┘
```

nginx serves the UI and reverse-proxies the API, so the browser only ever talks to one
origin. The frontend detects this automatically: when it is **not** served from
`localhost` it calls `location.origin + "/webhooks/rest/webhook"` (see `frontend/app.js`),
so no CORS handling or ngrok tunnel is required in production.

Relevant files: `Dockerfile`, `deploy/nginx.conf`, `deploy/start.sh`, `docker-compose.yml`.

## Secrets

Every secret is **optional** — the assistant runs on the curated seed data and stored
emission factors without any of them. All are read from the environment only and are never
printed, logged or committed.

| Variable | Enables |
|---|---|
| `NEON_DATABASE_URL` | Live NeonDB knowledge base (else local JSON) |
| `CLIMATIQ_API_KEY` | Live carbon-emission factors |
| `AVIATIONSTACK_API_KEY` | Real sample flight on the transport card |
| `OPENCAGE_API_KEY` | Friendly place name for a GPS fix |
| `OPENROUTESERVICE_API_KEY` | Road-routed distance for ground transport |

## A. Run locally with Docker

```bash
cp .env.example .env        # optional: paste your keys into .env
docker compose up --build   # builds the image (trains the model) and starts it
# open http://localhost:7860
```

Or without compose:

```bash
docker build -t eco-travel-advisor .
docker run -p 7860:7860 --env-file .env eco-travel-advisor
```

The first build is slow (it installs Rasa/TensorFlow and trains the model); later builds
reuse cached layers.

## B. Deploy to Hugging Face Spaces (recommended, zero cost)

1. Create a free account at <https://huggingface.co>.
2. **New → Space.** Choose **Docker** as the SDK (blank template) and a name, e.g.
   `eco-travel-advisor`. This creates a git repository for the Space.
3. Push the project to the Space. The repository already contains the `Dockerfile` and the
   Space metadata at the top of `README.md`, so no extra files are needed:

   ```bash
   git remote add space https://huggingface.co/spaces/<your-username>/eco-travel-advisor
   git push space main
   ```

   (Alternatively, drag-and-drop the files in the Space's **Files** tab.)
4. **Settings → Variables and secrets → New secret.** Add any of the keys from the table
   above you want to enable. They are injected as environment variables at runtime.
5. The Space builds the image automatically and, once the build finishes, serves the UI at
   `https://<your-username>-eco-travel-advisor.hf.space`. Share that URL — it is stable
   (no ngrok, no interstitial).

### Notes

- Hugging Face routes traffic to port **7860**; this is declared by `app_port: 7860` in the
  `README.md` front matter and matches the port nginx listens on.
- The model is trained during the image build, so the Space starts quickly and needs no
  secrets to build.
- Free Spaces sleep after a period of inactivity and wake on the next request (the first
  request after sleeping is slower).
