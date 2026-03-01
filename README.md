# Stash

A responsive financial dashboard built with **Next.js 14**, **Tailwind CSS**, and **Lucide React** icons. Charcoal background with light blue accents.

## Features

- **Sidebar navigation**: New Expense, Expenses (default), Budget, Net Worth
- **Month selector**: Dropdown in the top right (January 2026 – December 2026, plus Full Year 2026)
- **Responsive layout**: Collapsible sidebar on desktop; drawer overlay on mobile
- **Theme**: Charcoal (`#1E1E1E`) with light blue accent (`#7BC0FF`)
- **Google Sheets backend**: Optional; connect via a Google Apps Script Web App (see below).
- **Budget goals**: Stored in the browser (localStorage).

## Google Sheets backend

1. Create a Google Sheet with row 1 headers: **Timestamp**, **Expense Type**, **Amount**, **Description**, **Month**.
2. Use the sample script in `docs/google-apps-script-sample.js`: Extensions → Apps Script, paste the code, then Deploy → New deployment → Web app. Copy the Web App URL.
3. Create `.env.local` from `.env.example` and set `NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL` to that URL.
4. Restart the dev server. The Expenses page will load data from the sheet; the New Expense form will append rows (Timestamp is set by the script).

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` – development server
- `npm run build` – production build
- `npm run start` – run production server
- `npm run lint` – run ESLint
