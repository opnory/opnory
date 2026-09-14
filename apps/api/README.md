
## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPNORY_TRUST_PROXY_CIDRS` | No | `""` | Comma-separated CIDR ranges of trusted proxies (e.g., Caddy upstream). Used to configure Fastify `trustProxy` allowlist. For Gate 2 production, set to the exact Caddy container IP or subnet (e.g., `172.20.0.2/32`). |
| `OPNORY_CORS_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed CORS origins (e.g., `https://app.example.com,https://admin.example.com`). **Whitespace is not trimmed** — avoid spaces after commas. |
