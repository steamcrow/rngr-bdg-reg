# rngr-bdg-reg

Monster Rangers badge registration for monsterrangers.com (Odoo 19).

- `web/my-badges.js`: the My Badges screen (loaded on the website). Holds no secrets and decides nothing.
- `web/ranger-card.js`: the Ranger Card on the account page (/my): Persona name, Branch, Barrow, Order of Obscuria status. Requests only; the Worker validates.
- `web/leaderboard.js`: the Glory Leaderboard (shows a seal for OoO Members).
- `worker/`: the Cloudflare Worker that checks badge claims. Secrets live in Cloudflare, never in this repo.

This repository is PUBLIC. Never commit secret badge codes, member emails, API keys, or exports.
Files with PRIVATE in the name, CSV/XLSX files and backups are ignored on purpose.
