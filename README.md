# Home Board

Small self-hosted dashboard for a wall display. It is designed to run on a NAS and be opened as a single URL.

## What works

- Google Calendar via private iCal/ICS URLs, multiple calendars and colors.
- Apple Reminders as task items via iPhone Shortcuts push sync.
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
docker compose up -d --build
```

Then point the screen at `http://YOUR_NAS_IP:4173`.

Synced reminder data is stored in `./data/reminders.json`, which is mounted into the container.

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

## iPhone Reminders push sync

Upgraded iCloud Reminders are not available through CalDAV. The supported path is to push reminders from a Shortcut to the board:

```text
POST http://YOUR_NAS_IP:4173/api/sync/reminders?token=YOUR_REMINDER_SYNC_TOKEN
```

The token is configured in `config.json` under `reminderSync.token`.

Recommended iPhone Shortcut payload:

```json
{
  "reminders": "{\"Completed\":\"No\",\"List\":\"Shared\",\"Title\":\"Buy milk\",\"Deadline\":\"7 Jun 2026 at 00:00\"}\n{\"Completed\":\"No\",\"List\":\"Home\",\"Title\":\"Water plants\",\"Deadline\":\"8 Jun 2026 at 00:00\"}"
}
```

That is one `reminders` text field containing newline-separated JSON objects. The server also accepts a normal JSON array, but the text form is often easier to produce reliably in iOS Shortcuts.

Shortcut outline:

1. Add **Find Reminders**.
2. Filter to incomplete reminders. Optionally limit to reminders with due dates if you only want calendar tasks.
3. Repeat with each reminder.
4. Inside the repeat, create a Dictionary with `Title`, `List`, `Deadline`, and `Completed`.
5. After the repeat, use **Get Contents of URL**:
   - Method: `POST`
   - Request Body: `JSON`
   - URL: `http://YOUR_NAS_IP:4173/api/sync/reminders?token=YOUR_REMINDER_SYNC_TOKEN`
   - Body field type: `Text`
   - Body field name: `reminders`
   - Body field value: `Repeat Results`
6. Run it once manually and check that the response reports the expected reminder count.

For automatic local-network sync, create a personal automation: **When I Join Wi-Fi** -> run this Shortcut. iPhone background scheduling is not a strict daemon, so Wi-Fi join and a few time-of-day automations are more reliable than expecting exact five-minute sync.

## Integration issues

The app shows the `Integration issues` panel only when a configured source fails. If you see `Family: 404` or `Work: 404`, it means the calendar URL is not a real private iCal URL or is no longer accessible.
