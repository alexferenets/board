import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.BOARD_PORT || 4173);
const host = process.env.BOARD_HOST || "127.0.0.1";

const weatherCodes = new Map([
  [0, "Clear"],
  [1, "Mainly clear"],
  [2, "Partly cloudy"],
  [3, "Cloudy"],
  [45, "Fog"],
  [48, "Fog"],
  [51, "Light drizzle"],
  [53, "Drizzle"],
  [55, "Heavy drizzle"],
  [61, "Light rain"],
  [63, "Rain"],
  [65, "Heavy rain"],
  [71, "Light snow"],
  [73, "Snow"],
  [75, "Heavy snow"],
  [80, "Rain showers"],
  [81, "Rain showers"],
  [82, "Heavy showers"],
  [95, "Thunderstorm"]
]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function isPlaceholderUrl(url = "") {
  return !url || /YOUR_|example\.com|PLACEHOLDER/i.test(url);
}

async function loadConfig() {
  const configPath = existsSync(path.join(rootDir, "config.json"))
    ? path.join(rootDir, "config.json")
    : path.join(rootDir, "config.example.json");
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function unfoldIcs(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .reduce((lines, line) => {
      if (/^[ \t]/.test(line) && lines.length) {
        lines[lines.length - 1] += line.slice(1);
      } else {
        lines.push(line);
      }
      return lines;
    }, []);
}

function parseIcsValue(line) {
  const separator = line.indexOf(":");
  if (separator === -1) return null;
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";");
  const [name, ...paramParts] = left.split(";");
  const params = Object.fromEntries(paramParts.map((part) => {
    const [key, ...rest] = part.split("=");
    return [key.toUpperCase(), rest.join("=")];
  }));
  return { name: name.toUpperCase(), params, value };
}

function parseIcsDate(field) {
  if (!field?.value) return null;
  const value = field.value;
  if (field.params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    return { date: new Date(year, month, day), allDay: true };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const args = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)];
  return { date: z ? new Date(Date.UTC(...args)) : new Date(...args), allDay: false };
}

function parseBlocks(text, type) {
  const lines = unfoldIcs(text);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line === `BEGIN:${type}`) current = {};
    if (!current) continue;
    const parsed = parseIcsValue(line);
    if (parsed && parsed.name !== "BEGIN" && parsed.name !== "END") {
      current[parsed.name] = parsed;
    }
    if (line === `END:${type}`) {
      blocks.push(current);
      current = null;
    }
  }
  return blocks;
}

function decodeXmlEntities(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseRrule(value) {
  if (!value) return null;
  return Object.fromEntries(value.split(";").map((part) => {
    const [key, ...rest] = part.split("=");
    return [key, rest.join("=")];
  }));
}

function expandEvent(block, calendar, rangeStart, rangeEnd) {
  const start = parseIcsDate(block.DTSTART);
  if (!start) return [];
  const end = parseIcsDate(block.DTEND);
  const duration = end ? end.date.getTime() - start.date.getTime() : start.allDay ? 86400000 : 3600000;
  const rrule = parseRrule(block.RRULE?.value);
  const base = {
    id: `${calendar.name}:${block.UID?.value || block.SUMMARY?.value || start.date.toISOString()}`,
    title: block.SUMMARY?.value || "Untitled",
    location: block.LOCATION?.value || "",
    calendar: calendar.name,
    color: calendar.color,
    allDay: start.allDay
  };
  const make = (date, index = 0) => ({
    ...base,
    id: `${base.id}:${index}`,
    start: date.toISOString(),
    end: new Date(date.getTime() + duration).toISOString()
  });

  if (!rrule) return start.date < rangeEnd && new Date(start.date.getTime() + duration) >= rangeStart ? [make(start.date)] : [];

  const freq = rrule.FREQ || "DAILY";
  const interval = Number(rrule.INTERVAL || 1);
  const count = Number(rrule.COUNT || 500);
  const until = parseIcsDate({ value: rrule.UNTIL || "" })?.date || rangeEnd;
  const byday = rrule.BYDAY ? new Set(rrule.BYDAY.split(",")) : null;
  const weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const events = [];
  let cursor = new Date(start.date);
  let emitted = 0;
  let steps = 0;

  while (cursor <= rangeEnd && cursor <= until && emitted < count && steps < 730) {
    const inRange = cursor < rangeEnd && new Date(cursor.getTime() + duration) >= rangeStart;
    const bydayMatch = !byday || byday.has(weekdayCodes[cursor.getDay()]);
    if (inRange && bydayMatch) events.push(make(cursor, emitted));
    if (bydayMatch) emitted += 1;
    if (freq === "WEEKLY" && byday) {
      cursor = addDays(cursor, 1);
    } else if (freq === "WEEKLY") {
      cursor = addDays(cursor, 7 * interval);
    } else if (freq === "MONTHLY") {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + interval, cursor.getDate(), cursor.getHours(), cursor.getMinutes(), cursor.getSeconds());
    } else {
      cursor = addDays(cursor, interval);
    }
    steps += 1;
  }
  return events;
}

async function fetchCalendars(config) {
  const rangeStart = new Date();
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = addDays(rangeStart, 8);
  const calendars = (config.calendars || []).filter((calendar) => !isPlaceholderUrl(calendar.url));
  const results = await Promise.allSettled(calendars.map(async (calendar) => {
    const response = await fetch(calendar.url);
    if (!response.ok) throw new Error(`${calendar.name}: ${response.status}`);
    const text = await response.text();
    return parseBlocks(text, "VEVENT").flatMap((block) => expandEvent(block, calendar, rangeStart, rangeEnd));
  }));
  return {
    events: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    errors: results.filter((result) => result.status === "rejected").map((result) => result.reason.message)
  };
}

async function fetchWeather(config) {
  if (!config.weather?.enabled) return null;
  const { latitude, longitude, label } = config.weather;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude,
    longitude,
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: "2",
    timezone: "auto"
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`weather: ${response.status}`);
  const data = await response.json();
  const hourly = data.hourly.time.map((time, index) => ({
    time,
    temp: Math.round(data.hourly.temperature_2m[index]),
    precipitation: data.hourly.precipitation_probability[index],
    summary: weatherCodes.get(data.hourly.weather_code[index]) || "Weather"
  })).filter((hour) => hour.time >= data.current.time).slice(0, 8);
  return {
    label,
    temp: Math.round(data.current.temperature_2m),
    feelsLike: Math.round(data.current.apparent_temperature),
    wind: Math.round(data.current.wind_speed_10m),
    summary: weatherCodes.get(data.current.weather_code) || "Weather",
    high: Math.round(data.daily.temperature_2m_max[0]),
    low: Math.round(data.daily.temperature_2m_min[0]),
    precipitation: data.daily.precipitation_probability_max[0],
    hourly
  };
}

async function fetchStocks(config) {
  const stocks = config.stock ? [config.stock] : (config.stocks || []).slice(0, 1);
  return Promise.all(stocks.map(async (stock) => fetchStock(stock).catch((error) => ({
    label: stock.label || stock.symbol,
    symbol: stock.symbol,
    error: error.message
  }))));
}

async function fetchStock(stock) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.symbol)}?range=1d&interval=1d`;
  try {
    const response = await fetch(yahooUrl);
    if (!response.ok) throw new Error(`Yahoo ${response.status}`);
    const data = await response.json();
    const result = data.chart?.result?.[0];
    const meta = result?.meta;
    const quote = result?.indicators?.quote?.[0];
    const close = meta?.regularMarketPrice ?? quote?.close?.findLast((value) => Number.isFinite(value));
    if (!Number.isFinite(close)) throw new Error("Yahoo quote is missing price");
    return {
      symbol: meta.symbol || stock.symbol,
      label: stock.label || stock.symbol,
      date: new Date((meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString().slice(0, 10),
      time: new Date((meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString().slice(11, 16),
      open: quote?.open?.find((value) => Number.isFinite(value)) ?? null,
      high: quote?.high?.findLast((value) => Number.isFinite(value)) ?? null,
      low: quote?.low?.findLast((value) => Number.isFinite(value)) ?? null,
      close,
      volume: quote?.volume?.findLast((value) => Number.isFinite(value)) ?? null
    };
  } catch (error) {
    return fetchStooqStock(stock, error.message);
  }
}

async function fetchStooqStock(stock, yahooError) {
  const symbol = stock.stooqSymbol || `${stock.symbol}.US`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const response = await fetch(url);
  if (!response.ok) throw new Error(`${stock.symbol}: Yahoo ${yahooError}; Stooq ${response.status}`);
  const text = await response.text();
  const [header, row] = text.trim().split("\n");
  if (!header?.startsWith("Symbol,Date,Time") || !row) {
    throw new Error(`${stock.symbol}: Yahoo ${yahooError}; Stooq returned non-CSV data`);
  }
    const [stooqSymbol, date, time, open, high, low, close, volume] = row.split(",");
  const closeNumber = Number(close);
  if (!Number.isFinite(closeNumber)) {
    throw new Error(`${stock.symbol}: Yahoo ${yahooError}; Stooq quote is missing price`);
  }
    return {
      symbol: stooqSymbol,
      label: stock.label || stock.symbol,
      date,
      time,
      open: Number(open),
      high: Number(high),
      low: Number(low),
    close: closeNumber,
      volume: Number(volume)
    };
}

async function fetchAppleReminders(config) {
  const apple = config.appleReminders;
  if (!apple?.enabled) return { reminders: [], errors: [] };
  const auth = Buffer.from(`${apple.username}:${apple.appPassword}`).toString("base64");
  const now = new Date();
  const rangeEnd = addDays(now, 30);
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-data /></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO" /></C:comp-filter></C:filter>
</C:calendar-query>`;
  const lists = (apple.lists || []).filter((list) => !isPlaceholderUrl(list.url));
  const results = await Promise.allSettled(lists.map(async (list) => {
    const response = await fetch(list.url, {
      method: "REPORT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1"
      },
      body
    });
    if (!response.ok) throw new Error(`${list.name}: ${response.status}`);
    const xml = await response.text();
    const calendarData = [...xml.matchAll(/<[^/>:]*:?calendar-data[^>]*>([\s\S]*?)<\/[^>]*:?calendar-data>/g)]
      .map((match) => decodeXmlEntities(match[1]))
      .join("\n");
    const source = calendarData || decodeXmlEntities(xml);
    const matches = [...source.matchAll(/BEGIN:VTODO[\s\S]*?END:VTODO/g)];
    return matches.map((match) => parseBlocks(match[0], "VTODO")[0]).filter(Boolean).map((todo) => {
      const due = parseIcsDate(todo.DUE);
      return {
        id: todo.UID?.value || todo.SUMMARY?.value,
        title: todo.SUMMARY?.value || "Reminder",
        list: list.name,
        color: list.color,
        due: due?.date.toISOString() || null,
        allDay: Boolean(due?.allDay),
        completed: Boolean(todo.COMPLETED?.value || todo.STATUS?.value === "COMPLETED")
      };
    }).filter((todo) => todo.due && !todo.completed && new Date(todo.due) <= rangeEnd);
  }));
  return {
    reminders: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    errors: results.filter((result) => result.status === "rejected").map((result) => result.reason.message)
  };
}

function remindersToTaskEvents(reminders) {
  return reminders.map((reminder) => {
    const start = new Date(reminder.due);
    const end = new Date(start);
    if (reminder.allDay) {
      end.setDate(end.getDate() + 1);
    } else {
      end.setMinutes(end.getMinutes() + 15);
    }
    return {
      id: `task:${reminder.id}`,
      title: reminder.title,
      calendar: reminder.list,
      color: reminder.color,
      allDay: reminder.allDay,
      start: start.toISOString(),
      end: end.toISOString(),
      kind: "task",
      due: reminder.due
    };
  });
}

async function getState() {
  const config = await loadConfig();
  const [calendarData, weather, stocks, reminderData] = await Promise.all([
    fetchCalendars(config).catch((error) => ({ events: [], errors: [error.message] })),
    fetchWeather(config).catch((error) => ({ error: error.message })),
    fetchStocks(config).catch((error) => [{ error: error.message }]),
    fetchAppleReminders(config).catch((error) => ({ reminders: [], errors: [error.message] }))
  ]);
  return {
    title: config.title,
    locale: config.locale || "en-US",
    timeZone: config.timeZone || "UTC",
    refreshSeconds: config.refreshSeconds || 300,
    generatedAt: new Date().toISOString(),
    weather,
    stocks,
    events: [...calendarData.events, ...remindersToTaskEvents(reminderData.reminders)].sort((a, b) => new Date(a.start) - new Date(b.start)),
    reminders: reminderData.reminders.sort((a, b) => new Date(a.due) - new Date(b.due)),
    shopping: [],
    errors: [...(calendarData.errors || []), ...(reminderData.errors || [])]
  };
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = path.normalize(requestPath === "/" ? "/index.html" : requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "public, max-age=60"
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/state")) {
      jsonResponse(res, 200, await getState());
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    jsonResponse(res, 500, { error: error.message });
  }
}).listen(port, host, () => {
  console.log(`Home Board listening on http://${host}:${port}`);
});
