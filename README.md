# Invoice Scraper (Next.js)

Aplikacja uruchamia scraper iDoSell i pokazuje status/faktury na stronie głównej.

## Lokalny start

1. Zainstaluj zależności:

```bash
npm install
```

2. Skopiuj zmienne środowiskowe i wpisz swoje dane:

```bash
cp .env.example .env.local
```

3. Uruchom aplikację:

```bash
npm run dev
```

4. Otwórz http://localhost:3000

## Gdzie dodać login i hasło (bez wrzucania do GitHub)

Nigdy nie wpisuj loginu i hasła bezpośrednio w kodzie. Używaj tylko zmiennych środowiskowych:

- `INVOICE_PANEL_LOGIN`
- `INVOICE_PANEL_PASSWORD`

Plik `.env.local` jest ignorowany przez git (`.gitignore` ma wpis `.env*`), więc dane nie trafią do repozytorium.

## Vercel

1. Zaimportuj repo do Vercel.
2. W projekcie Vercel przejdź do: Settings -> Environment Variables.
3. Dodaj:

- `INVOICE_PANEL_LOGIN`
- `INVOICE_PANEL_PASSWORD`
- opcjonalnie: `INVOICE_START_ID`, `INVOICE_DEBUG`

4. Zrób deploy.

Kod używa Playwright i uruchamia Chromium kompatybilne z Vercel (`@sparticuz/chromium`) po stronie serwera.

## API

- `GET /api/invoices` - pobiera status
- `GET /api/invoices?forceRefresh=true` - pobiera status i wymusza odświeżenie
- `POST /api/invoices` - wymusza odświeżenie scrapera
- `GET /api/invoices/:invoiceId/xlsx` - pobiera XLSX dla faktury z ostatniego statusu
