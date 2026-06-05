# Home Board

Small self-hosted dashboard for a wall display. It is designed to run on a NAS and be opened as a single URL.

## What works

- Google Calendar via private iCal/ICS URLs, multiple calendars and colors.
- Apple Reminders as task items in the weekly calendar, via CalDAV `VTODO` lists when iCloud exposes them.
- Weather for today via Open-Meteo.
- A compact NBIS quote.
- Clock, hourly weather preview, seven-day agenda, and an explicit shopping-list slot.

Bring! is intentionally left disabled for now. Their stable public API is not available, so it should be added only if you are comfortable relying on an unofficial adapter.

## Run locally

```bash
cp config.example.json config.json
npm start
```

Open `http://localhost:4173`.

## Docker / NAS

```bash
docker compose up -d
```

Then point the screen at `http://YOUR_NAS_IP:4173`.

## Google Calendar setup

Google documents this as subscribing through the calendar's **Secret address in iCal format**: <https://support.google.com/calendar/answer/37648>

For each calendar:

1. Open Google Calendar settings.
2. Choose the calendar.
3. Copy the **Secret address in iCal format**.
4. Put it into `config.json` under `calendars[].url`.

Example:

```json
{
  "calendars": [
    {
      "name": "Family",
      "color": "#3b82f6",
      "url": "https://calendar.google.com/calendar/ical/.../basic.ics"
    },
    {
      "name": "Work",
      "color": "#f97316",
      "url": "https://calendar.google.com/calendar/ical/.../basic.ics"
    }
  ]
}
```

The secret iCal link is effectively a read-only secret token. Do not publish it.

## Apple Reminders setup

Apple Reminders can be exposed through iCloud CalDAV as `VTODO` items, but Apple does not make the list URLs pleasant to discover and some accounts may not expose upgraded Reminders this way. This app expects explicit list URLs in `appleReminders.lists[]`.

Use an Apple app-specific password, not your normal Apple ID password: <https://support.apple.com/102654>

1. Create an Apple app-specific password.
2. Run discovery:

```bash
APPLE_ID='apple-id@example.com' APPLE_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' npm run discover:apple
```

3. Copy the printed `appleReminders` block into `config.json`.
4. Replace `PASTE_APP_SPECIFIC_PASSWORD_HERE` with the app-specific password.

Reminder items with due dates are rendered in the main week view as `Task` items.

## Integration issues

The app shows the `Integration issues` panel only when a configured source fails. If you see `Family: 404` or `Work: 404`, it means the calendar URL is not a real private iCal URL or is no longer accessible.
