let state = {
  locale: "en-US",
  timeZone: "UTC",
  refreshSeconds: 300,
  events: [],
  reminders: []
};

const els = {
  time: document.querySelector("#time"),
  date: document.querySelector("#date"),
  title: document.querySelector("#title"),
  updated: document.querySelector("#updated"),
  weather: document.querySelector("#weather"),
  stocks: document.querySelector("#stocks"),
  agenda: document.querySelector("#agenda"),
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
  els.time.textContent = fmtDate(now, { hour: "2-digit", minute: "2-digit" });
  els.date.textContent = fmtDate(now, { weekday: "long", day: "numeric", month: "long" });
}

function renderWeather(weather) {
  if (!weather || weather.error) {
    els.weather.innerHTML = `<div class="muted-list">${escapeHtml(weather?.error || "Weather is disabled")}</div>`;
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
    els.stocks.innerHTML = `<div class="muted-list">No symbols configured</div>`;
    return;
  }
  els.stocks.innerHTML = stocks.map((stock) => {
    if (stock.error) return `<div class="error-item">${escapeHtml(stock.error)}</div>`;
    return `
      <div class="stock-row">
        <div>
          <div class="stock-symbol">${escapeHtml(stock.label)}</div>
          <div class="stock-meta">${escapeHtml(stock.date)} · ${escapeHtml(stock.time)} UTC</div>
        </div>
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
          <div class="event-meta">${eventTime(event)} · ${escapeHtml(event.calendar)}</div>
        </article>
      `).join("")
      : `<div class="empty">No events</div>`;
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

function render(nextState) {
  state = nextState;
  document.documentElement.lang = state.locale;
  document.title = state.title || "Home Board";
  els.title.textContent = state.title || "Home Board";
  els.updated.textContent = `Updated ${fmtDate(new Date(state.generatedAt), { hour: "2-digit", minute: "2-digit" })}`;
  tickClock();
  renderWeather(state.weather);
  renderStocks(state.stocks);
  renderAgenda(state.events);
  renderErrors(state.errors);
}

async function loadState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`State failed: ${response.status}`);
  render(await response.json());
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

tickClock();
window.setInterval(tickClock, 1000);
refreshLoop();
