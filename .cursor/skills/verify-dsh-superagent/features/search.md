# Search

Header search finds tickets by title and triggers by text, and it shows a distinct empty state when nothing matches. Searching does not change stored tickets.

## Sub-features

- `search-title` returns `Release checklist` for `release` and does not return `Grocery list`.
- `search-trigger` returns the trigger `Draft budget` for `budget` and does not return either ticket title inside the results region.
- `search-empty` shows the GitHub empty copy for `volcano`.
- `search-unchanged` leaves both seeded tickets and the trigger in SQLite.

## How to get to it (user POV)

- Use the header search box labeled `Search` on any tab. Submit the query with Enter.

## Driving it with verify-dsh-superagent

Preconditions:

- `verify.mjs doctor` reports `"ok": true`.
- The store contains `Release checklist`, `Grocery list`, and trigger text `Draft budget`.

- **Title match.** Choose the search box, type `release`, and press Enter. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser fill --role searchbox --name "Search" --value "release"` and `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser press --key "Enter"`, then `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser wait --text "Found 1 Tickets"`. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser region --name "Search"`. The region contains `Release checklist` and `Awaiting answer`, and does not contain `Grocery list`.
- **Trigger match.** Replace the query with `budget` and press Enter. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser fill --role searchbox --name "Search" --value "budget"` and `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser press --key "Enter"`, then `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser wait --text "Found 0 Tickets, 0 Threads and 1 Triggers"`. The `Search` region contains `Draft budget` and does not contain `Release checklist` or `Grocery list`.
- **Empty state.** Replace the query with `volcano` and press Enter. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser fill --role searchbox --name "Search" --value "volcano"` and `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser press --key "Enter"`, then `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser wait --text "Nothing found"`. The region reads `Nothing found. Try Trigger text, a GitHub PR or Issue link, or #number.`
- **Stored rows.** Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET search --query q=release` and `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs records`. The API body has one ticket titled `Release checklist`. `records` still lists `Release checklist`, `Grocery list`, and `Draft budget`.
- **Proof.** With the `release` results open, run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser snapshot --aria --path .cursor/skills/verify-dsh-superagent/evidence/search/search-release.aria.txt` and `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser screenshot --path .cursor/skills/verify-dsh-superagent/evidence/search/search-release.png`. The artifacts show the stand-in banner, the query `release`, and `Release checklist`.

## Gotchas

- Page text still contains `Release checklist` while a later query is open, because the overview stays mounted behind the dropdown. Assert the `Search` region.
- `browser wait --text "Release checklist"` is not a search proof. The overview already shows that ticket. Wait for `Found 1 Tickets`.
- Clearing the box closes the region. There is no **Clear search** control. Pressing `/` does not open search.
- The product copy is `Found 1 Tickets`, including the plural. Assert that string.
- Results are not debounced. They appear after the form submit returns.
- A matching title does not prove GitHub search or a live notification. The rows were seeded.
