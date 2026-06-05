import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const defaultDataDir = path.join(rootDir, "data");
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

function badRequest(res, message) {
  jsonResponse(res, 400, { error: message });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function isPlaceholderUrl(url = "") {
  return !url || /YOUR_|example\.com|PLACEHOLDER/i.test(url);
}

function isCalDavCollectionUrl(url = "") {
  return /\/calendars\/(?:outbox\/?)?$/i.test(url);
}

function isAppleSystemReminder(title = "") {
  return [
    "The creator of this list has upgraded these reminders.",
    "Where are my reminders?"
  ].includes(title.trim());
}

function resolveDataPath(configPath = "data/reminders.json") {
  return path.isAbsolute(configPath) ? configPath : path.join(rootDir, configPath);
}

function getReminderSyncConfig(config) {
  const sync = config.reminderSync || {};
  return {
    enabled: sync.enabled !== false,
    token: sync.token || process.env.REMINDER_SYNC_TOKEN || "",
    path: resolveDataPath(sync.path || "data/reminders.json")
  };
}

function isPlaceholderToken(token = "") {
  return !token || /change|example|token/i.test(token);
}

function describeGoogleCalendarUrlProblem(url = "") {
  if (!/calendar\.google\.com/i.test(url)) return "";
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (!parts.includes("ical") || parts.at(-1) !== "basic.ics") {
      return " - Google calendar URL must be an iCal basic.ics URL";
    }
    if (!parts.some((part) => part.startsWith("private-")) && !parts.includes("public")) {
      return " - this looks like a calendar ID URL; copy the full Secret address in iCal format, including the private-... segment";
    }
  } catch {
    return " - invalid Google calendar URL";
  }
  return "";
}

async function loadConfig() {
  const configPath = existsSync(path.join(rootDir, "config.json"))
    ? path.join(rootDir, "config.json")
    : path.join(rootDir, "config.example.json");
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readRequestJson(req, maxBytes = 512000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const params = field.params || {};
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
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

function parseExternalDue(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, allDay: false };
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    return { date: new Date(year, month - 1, day), allDay: true };
  }
  const normalizedText = text.replace(/\s+at\s+/i, " ");
  const date = new Date(normalizedText);
  const allDay = /\bat\s+00:00$/i.test(text) || /\s00:00$/.test(normalizedText);
  return Number.isNaN(date.getTime()) ? null : { date, allDay };
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
      if (parsed.name === "EXDATE") {
        current.EXDATE = [...(current.EXDATE || []), parsed];
      } else {
        current[parsed.name] = parsed;
      }
    }
    if (line === `END:${type}`) {
      blocks.push(current);
      current = null;
    }
  }
  return blocks;
}

function parseIcsDateList(fields) {
  return (Array.isArray(fields) ? fields : fields ? [fields] : []).flatMap((field) =>
    field.value.split(",").map((value) => parseIcsDate({ ...field, value })).filter(Boolean)
  );
}

function recurrenceKey(block, date) {
  const uid = block.UID?.value || block.SUMMARY?.value || "";
  return `${uid}:${date.getTime()}`;
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

function expandEvent(block, calendar, rangeStart, rangeEnd, skippedRecurrences = new Set()) {
  if (block.STATUS?.value === "CANCELLED") return [];
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
  const exdates = new Set(parseIcsDateList(block.EXDATE).map((item) => recurrenceKey(block, item.date)));
  const events = [];
  let cursor = new Date(start.date);
  let emitted = 0;
  let steps = 0;

  while (cursor <= rangeEnd && cursor <= until && emitted < count && steps < 730) {
    const inRange = cursor < rangeEnd && new Date(cursor.getTime() + duration) >= rangeStart;
    const bydayMatch = !byday || byday.has(weekdayCodes[cursor.getDay()]);
    const excluded = skippedRecurrences.has(recurrenceKey(block, cursor)) || exdates.has(recurrenceKey(block, cursor));
    if (inRange && bydayMatch && !excluded) events.push(make(cursor, emitted));
    if (bydayMatch) emitted += 1;
    if (freq === "WEEKLY" && byday) {
      cursor = addDays(cursor, 1);
    } else if (freq === "WEEKLY") {
      cursor = addDays(cursor, 7 * interval);
    } else if (freq === "MONTHLY") {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + interval, cursor.getDate(), cursor.getHours(), cursor.getMinutes(), cursor.getSeconds());
    } else if (freq === "YEARLY") {
      cursor = new Date(cursor.getFullYear() + interval, cursor.getMonth(), cursor.getDate(), cursor.getHours(), cursor.getMinutes(), cursor.getSeconds());
    } else {
      cursor = addDays(cursor, interval);
    }
    steps += 1;
  }
  return events;
}

function expandCalendarBlocks(blocks, calendar, rangeStart, rangeEnd) {
  const overrides = blocks.filter((block) => block["RECURRENCE-ID"]);
  const overrideKeys = new Set(overrides.map((block) => {
    const recurrence = parseIcsDate(block["RECURRENCE-ID"]);
    return recurrence ? recurrenceKey(block, recurrence.date) : null;
  }).filter(Boolean));
  return blocks.flatMap((block) => expandEvent(block, calendar, rangeStart, rangeEnd, overrideKeys));
}

async function fetchCalendars(config) {
  const rangeStart = new Date();
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = addDays(rangeStart, 8);
  const calendars = (config.calendars || []).filter((calendar) => !isPlaceholderUrl(calendar.url));
  const results = await Promise.allSettled(calendars.map(async (calendar) => {
    try {
      const shapeProblem = describeGoogleCalendarUrlProblem(calendar.url);
      if (shapeProblem) throw new Error(shapeProblem.replace(/^ - /, ""));
      const response = await fetch(calendar.url);
      if (!response.ok) {
        const hint = response.status === 404 && /calendar\.google\.com/i.test(calendar.url)
          ? " - copy Google Calendar's full Secret address in iCal format"
          : "";
        throw new Error(`${response.status}${hint}`);
      }
      const text = await response.text();
      return expandCalendarBlocks(parseBlocks(text, "VEVENT"), calendar, rangeStart, rangeEnd);
    } catch (error) {
      throw new Error(`${calendar.name}: ${error.message}`);
    }
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
  const lists = (apple.lists || []).filter((list) => !isPlaceholderUrl(list.url) && !isCalDavCollectionUrl(list.url));
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
    }).filter((todo) => !todo.completed && !isAppleSystemReminder(todo.title) && (!todo.due || new Date(todo.due) <= rangeEnd));
  }));
  return {
    reminders: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    errors: results.filter((result) => result.status === "rejected").map((result) => result.reason.message)
  };
}

function normalizeExternalReminder(raw, index, source = "sync") {
  const get = (...keys) => keys.find((key) => raw[key] !== undefined) ? raw[keys.find((key) => raw[key] !== undefined)] : undefined;
  const title = get("title", "Title", "name", "Name", "summary", "Summary");
  const completed = get("completed", "Completed", "isCompleted", "Is Completed", "IsCompleted");
  const status = get("status", "Status");
  const completedText = String(completed ?? "").toLowerCase();
  const isCompleted = completed === true || completedText === "true" || completedText === "yes" || status === "completed" || status === "Completed";
  if (!title || isCompleted) return null;
  if (isAppleSystemReminder(title)) return null;
  const due = parseExternalDue(get("due", "Due", "dueDate", "Due Date", "DueDate", "deadline", "Deadline"));
  return {
    id: String(get("id", "ID", "uid", "UID") || `${source}:${index}:${title}`),
    title: String(title),
    list: String(get("list", "List", "listName", "List Name", "ListName", "calendar", "Calendar") || source),
    color: String(get("color", "Color") || "#B14BC9"),
    due: due?.date.toISOString() || null,
    allDay: get("allDay", "All Day", "AllDay") ?? due?.allDay ?? false,
    completed: false,
    source
  };
}

function looksLikeReminderObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["title", "Title", "name", "Name", "summary", "Summary"].some((key) => value[key] !== undefined);
}

function parseShortcutJsonText(text) {
  if (!text.trim().startsWith("{")) return [];
  try {
    const parsed = JSON.parse(text);
    return looksLikeReminderObject(parsed) ? [parsed] : [];
  } catch {
    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => parseShortcutJsonText(line));
  }
}

function extractReminderItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return parseShortcutJsonText(value);
  if (looksLikeReminderObject(value)) return [value];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entryValue]) => {
    const parsedKeyItems = parseShortcutJsonText(key);
    if (parsedKeyItems.length) return parsedKeyItems;
    if (Array.isArray(entryValue)) return entryValue;
    if (looksLikeReminderObject(entryValue)) return [entryValue];
    return [];
  });
}

function normalizeReminderSyncPayload(payload) {
  const source = String(payload.source || payload.Source || "apple-reminders");
  const container = payload.reminders ?? payload.Reminders ?? payload.items ?? payload.Items ?? payload;
  const reminders = extractReminderItems(container);
  return {
    source,
    generatedAt: payload.generatedAt || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    reminders: reminders.map((item, index) => normalizeExternalReminder(item, index, source)).filter(Boolean)
  };
}

async function fetchSyncedReminders(config) {
  const sync = getReminderSyncConfig(config);
  if (!sync.enabled) return { reminders: [], errors: [] };
  const payload = await readJsonFile(sync.path, null);
  if (!payload) return { reminders: [], errors: [] };
  return {
    reminders: (payload.reminders || []).filter((reminder) => !reminder.completed),
    errors: []
  };
}

async function handleReminderSync(req, res) {
  const config = await loadConfig();
  const sync = getReminderSyncConfig(config);
  if (!sync.enabled) {
    jsonResponse(res, 404, { error: "Reminder sync is disabled" });
    return;
  }
  if (isPlaceholderToken(sync.token)) {
    jsonResponse(res, 403, { error: "Reminder sync token is not configured" });
    return;
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : requestUrl.searchParams.get("token");
  if (token !== sync.token) {
    jsonResponse(res, 401, { error: "Invalid reminder sync token" });
    return;
  }
  let payload;
  try {
    payload = normalizeReminderSyncPayload(await readRequestJson(req));
  } catch (error) {
    badRequest(res, error.message);
    return;
  }
  await mkdir(path.dirname(sync.path), { recursive: true });
  await writeFile(sync.path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  jsonResponse(res, 200, {
    ok: true,
    receivedAt: payload.receivedAt,
    reminders: payload.reminders.length
  });
}

function remindersToTaskEvents(reminders) {
  return reminders.filter((reminder) => reminder.due).map((reminder) => {
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
  const [calendarData, weather, stocks, caldavReminderData, syncedReminderData] = await Promise.all([
    fetchCalendars(config).catch((error) => ({ events: [], errors: [error.message] })),
    fetchWeather(config).catch((error) => ({ error: error.message })),
    fetchStocks(config).catch((error) => [{ error: error.message }]),
    fetchAppleReminders(config).catch((error) => ({ reminders: [], errors: [error.message] })),
    fetchSyncedReminders(config).catch((error) => ({ reminders: [], errors: [error.message] }))
  ]);
  const reminders = [...caldavReminderData.reminders, ...syncedReminderData.reminders];
  return {
    title: config.title,
    locale: config.locale || "en-US",
    timeZone: config.timeZone || "UTC",
    refreshSeconds: config.refreshSeconds || 300,
    reloadSeconds: config.reloadSeconds || 300,
    generatedAt: new Date().toISOString(),
    weather,
    stocks,
    events: [...calendarData.events, ...remindersToTaskEvents(reminders)].sort((a, b) => new Date(a.start) - new Date(b.start)),
    reminders: reminders.sort((a, b) => new Date(a.due || 0) - new Date(b.due || 0)),
    shopping: [],
    errors: [...(calendarData.errors || []), ...(caldavReminderData.errors || []), ...(syncedReminderData.errors || [])]
  };
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (requestPath === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    res.end();
    return;
  }
  if (requestPath === "/" || requestPath === "/index.html") {
    try {
      const [body, config] = await Promise.all([
        readFile(path.join(publicDir, "index.html"), "utf8"),
        loadConfig()
      ]);
      const boot = {
        title: config.title || "Home Board",
        locale: config.locale || "en-US",
        timeZone: config.timeZone || "UTC",
        refreshSeconds: config.refreshSeconds || 300,
        reloadSeconds: config.reloadSeconds || 300
      };
      const html = body
        .replace("<html lang=\"nl-NL\">", `<html lang="${escapeHtml(boot.locale)}">`)
        .replace("<title>Home Board</title>", `<title>${escapeHtml(boot.title)}</title>`)
        .replace("window.__BOARD_BOOTSTRAP__ = {};", `window.__BOARD_BOOTSTRAP__ = ${JSON.stringify(boot)};`);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(html);
      return;
    } catch (error) {
      jsonResponse(res, 500, { error: error.message });
      return;
    }
  }
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
    if (req.url?.startsWith("/api/sync/reminders")) {
      if (req.method !== "POST") {
        jsonResponse(res, 405, { error: "Method not allowed" });
        return;
      }
      await handleReminderSync(req, res);
      return;
    }
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
