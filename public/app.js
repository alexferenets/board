const boot = window.__BOARD_BOOTSTRAP__ || {};
const cacheKey = "home-board-state-v1";

let state = {
  title: boot.title || "Home Board",
  locale: boot.locale || navigator.language || "en-US",
  timeZone: boot.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  refreshSeconds: boot.refreshSeconds || 300,
  reloadSeconds: boot.reloadSeconds || 300,
  events: [],
  reminders: [],
  errors: []
};

const els = {
  time: document.querySelector("#time"),
  date: document.querySelector("#date"),
  updated: document.querySelector("#updated"),
  weather: document.querySelector("#weather"),
  stocks: document.querySelector("#stocks"),
  agenda: document.querySelector("#agenda"),
  tasksPanel: document.querySelector("#tasks-panel"),
  tasks: document.querySelector("#tasks"),
  shopping: document.querySelector("#shopping"),
  errorsPanel: document.querySelector("#errors-panel"),
  errors: document.querySelector("#errors")
};

function fmtDate(date, options) {
  return new Intl.DateTimeFormat(state.locale, { timeZone: state.timeZone, ...options }).format(date);
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKey(date) {
  return fmtDate(date, { year: "numeric", month: "2-digit", day: "2-digit" });
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

function tickClock() {
  const now = new Date();
  els.time.textContent = fmtDate(now, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  els.date.textContent = fmtDate(now, { weekday: "long", day: "numeric", month: "long" });
}

function renderWeather(weather) {
  if (!weather || weather.error) {
    els.weather.innerHTML = weather?.error ? `<div class="muted-list">${escapeHtml(weather.error)}</div>` : "";
    return;
  }
  els.weather.innerHTML = `
    <div class="weather-temp">
      <strong>${weather.temp}&deg;</strong>
      <span>${escapeHtml(weather.summary)}</span>
    </div>
    <div class="weather-meta">
      ${escapeHtml(weather.label)} · feels ${weather.feelsLike}&deg; · H ${weather.high}&deg; / L ${weather.low}&deg; · rain ${weather.precipitation ?? 0}%
    </div>
    <div class="hourly">
      ${(weather.hourly || []).slice(1, 5).map((hour) => `
        <div class="hour">
          <div class="hour-time">${escapeHtml(hour.time.slice(11, 16))}</div>
          <div class="hour-temp">${hour.temp}&deg;</div>
          <div class="hour-rain">${hour.precipitation ?? 0}% rain</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderStocks(stocks = []) {
  if (!stocks.length) {
    els.stocks.innerHTML = "";
    return;
  }
  els.stocks.innerHTML = stocks.slice(0, 1).map((stock) => {
    if (stock.error) return `<div class="error-item">${escapeHtml(stock.error)}</div>`;
    return `
      <div class="stock-row">
        <div class="stock-symbol">${escapeHtml(stock.label)}</div>
        <div class="stock-price">${Number(stock.close).toFixed(2)}</div>
      </div>
    `;
  }).join("");
}

function eventTime(event) {
  if (event.kind === "task" && event.allDay) return "Due";
  const start = new Date(event.start);
  if (event.kind === "task") return `Due ${fmtDate(start, { hour: "2-digit", minute: "2-digit" })}`;
  if (event.allDay) return "All day";
  const end = new Date(event.end);
  return `${fmtDate(start, { hour: "2-digit", minute: "2-digit" })}–${fmtDate(end, { hour: "2-digit", minute: "2-digit" })}`;
}

function renderAgenda(events = []) {
  const today = startOfLocalDay(new Date());
  const byDay = new Map();
  for (const event of events) {
    const key = dayKey(new Date(event.start));
    byDay.set(key, [...(byDay.get(key) || []), event]);
  }

  els.agenda.innerHTML = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    const items = byDay.get(dayKey(date)) || [];
    const body = items.length
      ? items.map((event) => `
        <article class="event ${event.kind === "task" ? "task" : ""}" style="border-left-color:${escapeHtml(event.color || "#d6f36b")}">
          <div class="event-title">${escapeHtml(event.title)}</div>
          <div class="event-meta">${eventTime(event)}</div>
        </article>
      `).join("")
      : "";
    return `
      <section class="day">
        <header class="day-head">
          <div class="day-name">${fmtDate(date, { weekday: "short" })}</div>
          <div class="day-date">${fmtDate(date, { day: "numeric", month: "short" })}</div>
        </header>
        <div class="events">${body}</div>
      </section>
    `;
  }).join("");
}

function renderErrors(errors = []) {
  els.errorsPanel.classList.toggle("hidden", !errors.length);
  els.errors.innerHTML = errors.map((error) => `<div class="error-item">${escapeHtml(error)}</div>`).join("");
}

function renderTasks(reminders = []) {
  const undated = reminders.filter((reminder) => !reminder.due);
  els.tasksPanel.classList.toggle("hidden", !undated.length);
  if (!undated.length) {
    els.tasks.innerHTML = "";
    return;
  }
  els.tasks.innerHTML = undated.map((reminder) => `
    <div class="reminder">
      <span class="dot" style="background:${escapeHtml(reminder.color || "#d6f36b")}"></span>
      <div>
        <div class="reminder-title">${escapeHtml(reminder.title)}</div>
      </div>
    </div>
  `).join("");
}

function render(nextState) {
  state = { ...state, ...nextState };
  document.documentElement.lang = state.locale;
  document.title = state.title || "Home Board";
  els.updated.textContent = state.generatedAt
    ? `Updated ${fmtDate(new Date(state.generatedAt), { hour: "2-digit", minute: "2-digit" })}`
    : "";
  tickClock();
  renderWeather(state.weather);
  renderStocks(state.stocks);
  renderAgenda(state.events);
  renderTasks(state.reminders);
  renderErrors(state.errors);
}

async function loadState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`State failed: ${response.status}`);
  const nextState = await response.json();
  window.localStorage.setItem(cacheKey, JSON.stringify(nextState));
  render(nextState);
}

async function refreshLoop() {
  try {
    await loadState();
  } catch (error) {
    renderErrors([error.message]);
  } finally {
    window.setTimeout(refreshLoop, Math.max(30, state.refreshSeconds || 300) * 1000);
  }
}

function schedulePageReload() {
  const reloadSeconds = Math.max(60, state.reloadSeconds || 300);
  window.setTimeout(() => {
    window.location.reload();
  }, reloadSeconds * 1000);
}

function renderCachedState() {
  try {
    const cached = JSON.parse(window.localStorage.getItem(cacheKey) || "null");
    if (cached) {
      render(cached);
      return true;
    }
  } catch {
    window.localStorage.removeItem(cacheKey);
  }
  document.documentElement.lang = state.locale;
  document.title = state.title;
  tickClock();
  return false;
}

renderCachedState();
tickClock();
window.setInterval(tickClock, 1000);
refreshLoop();
schedulePageReload();
