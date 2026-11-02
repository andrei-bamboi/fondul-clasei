# Fondul Clasei

Aplicație web pentru evidența fondului clasei: soldul fiecărui elev, cheltuieli,
plăți și anunțuri de plată de la părinți. Rulează local cu Docker și nu are
dependențe externe (Node 22 + SQLite inclus în Node).

## Pornire

```bash
cp .env.example .env        # apoi editează .env și pune o parolă de casier
docker compose up -d --build
```

Deschide http://localhost:3000.

La prima pornire se importă automat datele din Excel (`seed.json`): 19 elevi,
15 cheltuieli și totalul virat de fiecare. Importul rulează doar dacă baza e goală.

## Cine ce poate face

| | Părinte (fără cont) | Casier (cu parolă) |
|---|---|---|
| Vede soldurile, cheltuielile, plățile | da | da |
| Vede IBAN-ul și codul de plată al copilului | da | da |
| Anunță o plată făcută | da | da |
| Adaugă / editează cheltuieli și plăți | — | da |
| Confirmă sau respinge plățile anunțate | — | da |
| Administrare: date cont, elevi, export CSV | — | da |

Casierul intră din butonul **Casier** din bara de tab-uri, cu parola din `ADMIN_PASSWORD`.

## Date și backup

Datele stau în volumul Docker `fond-data` (fișierul `fond.sqlite`).

```bash
# backup
docker compose exec fondul-clasei sh -c 'cp /data/fond.sqlite /data/backup.sqlite'
docker cp fondul-clasei:/data/backup.sqlite ./backup-$(date +%F).sqlite

# restaurare
docker compose stop
docker cp ./backup-2026-10-27.sqlite fondul-clasei:/data/fond.sqlite
docker compose start
```

Exportul CSV (Administrare → Descarcă CSV) se deschide direct în Excel.

## Comenzi utile

```bash
docker compose logs -f              # jurnal
docker compose down                 # oprește (datele rămân)
docker compose down -v              # oprește și ȘTERGE datele
docker compose up -d --build        # după o actualizare a codului
```

## Acces pentru părinți

Pe `localhost`, aplicația e accesibilă doar de pe calculatorul tău. Ca părinții
să o poată deschide de pe telefon, pune-o pe un server (VPS) în spatele unui
reverse proxy cu HTTPS (Caddy, Nginx, Traefik) sau folosește un tunel
(Cloudflare Tunnel, Tailscale Funnel). Când rulează în spatele unui proxy HTTPS,
cookie-ul de casier se marchează automat `Secure` (pe baza `X-Forwarded-Proto`).

## Fără Docker

Necesită Node.js 22.13 sau mai nou:

```bash
ADMIN_PASSWORD=parola node server.js
```

## API (pentru integrări)

- `GET /api/state` — toate datele + dacă ești casier
- `GET /api/events` — Server-Sent Events, anunță modificările (actualizare live)
- `POST /api/login` `{password}` / `POST /api/logout`
- `POST /api/claims` — anunț de plată (public)
- casier: `POST|PUT|DELETE /api/expenses[/:id]`, `/api/payments[/:id]`,
  `PUT|DELETE /api/students/:id`, `PUT /api/settings`,
  `POST /api/claims/:id/confirm`, `DELETE /api/claims/:id`, `GET /api/export.csv`
