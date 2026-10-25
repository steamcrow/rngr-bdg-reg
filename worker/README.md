# rngr-badge-checker (Cloudflare Worker)

Checks Badge Claims for monsterrangers.com. Odoo pings `/hook/<HOOK_SECRET>` when a claim is created; the Worker re-reads the claim
from Odoo, works out who made it from Odoo's own `create_uid`, checks the secret code (which never reaches the browser), creates the
registration, and writes the result back. A once-a-minute sweeper finishes any claim that was missed.

Rules it enforces: one badge per Ranger (race-safe), 5 wrong codes per 15 minutes then a lockout, codes wiped from claims after use,
archived (alias) products ignored, a code that matches two products is never awarded (status "Needs staff review").

Test it: `node test.mjs` (uses a pretend Odoo, needs nothing installed).
Deploy: see the steps Claude gave in chat (wrangler login, wrangler deploy, 5 secrets).
Never commit the secrets. The Odoo API key belongs to a dedicated staff-level integration user, not a person.
