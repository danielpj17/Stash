# Stash

A responsive financial dashboard built with **Next.js 14**, **Tailwind CSS**, and **Lucide React** icons. Charcoal background with light blue accents.

## Features

- **Sidebar navigation**: New Expense, Expenses (default), Budget, Net Worth
- **Month selector**: Dropdown in the top right (January 2026 – December 2026, plus Full Year 2026)
- **Responsive layout**: Collapsible sidebar on desktop; drawer overlay on mobile
- **Theme**: Charcoal (`#1E1E1E`) with light blue accent (`#7BC0FF`)
- **Google Sheets backend**: Optional; connect via a Google Apps Script Web App (see below).
- **Budget goals**: Stored in the browser (localStorage).
- **SnapTrade manual refresh**: Account Balances card can pull live brokerage balances on demand.

## Google Sheets backend

1. Create two tabs:
   - **Expenses** headers: **Timestamp**, **Expense Type**, **Amount**, **Description**, **Month**, **Row ID**
   - **Transfers** headers: **Timestamp**, **Transfer from**, **Transfer To**, **Transfer Amount**, **Month**, **Transfer Row ID**
2. Use the sample script in `docs/google-apps-script-sample.js`: Extensions → Apps Script, paste the code, then Deploy → New deployment → Web app. Copy the Web App URL.
3. Create `.env.local` from `.env.example` and set `NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL` to that URL.
4. Restart the dev server. The Expenses page will load data from the sheet; the New Expense form will append rows (Timestamp is set by the script).

For reconciliation claim-linking, each expense row must have a stable **Row ID**:
- new rows created via the sample script will get a UUID automatically
- older rows should be backfilled once manually in the sheet

For transfer leg claiming, each transfer row must have a stable **Transfer Row ID**:
- new rows created via the sample script will get a UUID automatically
- older transfer rows should be backfilled once manually in the sheet

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## SnapTrade manual account-balance refresh

The Budget page Account Balances card includes a refresh button in the card header. It only
fetches SnapTrade balances when clicked (no polling, no automatic refresh on page load).

Add these server-side env vars:

```bash
SNAPTRADE_CLIENT_ID=...
SNAPTRADE_CONSUMER_KEY=...
SNAPTRADE_USER_ID=...
SNAPTRADE_USER_SECRET=...
```

The app calls `/api/snaptrade/refresh-balances` and overlays live values for supported
brokerages (currently Fidelity, Robinhood, and Charles Schwab) while keeping other accounts
from local budget math.

## Scripts

- `npm run dev` – development server
- `npm run build` – production build
- `npm run start` – run production server
- `npm run lint` – run ESLint
