const username = process.env.APPLE_ID;
const appPassword = process.env.APPLE_APP_PASSWORD;

if (!username || !appPassword) {
  console.error("Usage: APPLE_ID='you@example.com' APPLE_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' npm run discover:apple");
  process.exit(1);
}

const auth = Buffer.from(`${username}:${appPassword}`).toString("base64");

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function firstTagValue(xml, tag) {
  const match = xml.match(new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function hrefFrom(xml) {
  return firstTagValue(xml, "href");
}

function resolveDavUrl(href, baseUrl) {
  return new URL(href, baseUrl).href;
}

async function propfind(url, body, depth = "0") {
  const response = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/xml; charset=utf-8",
      Depth: depth
    },
    body
  });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return {
    url: response.url,
    xml: await response.text()
  };
}

const principalResponse = await propfind("https://caldav.icloud.com/", `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal /></D:prop>
</D:propfind>`);

const principalHref = hrefFrom(firstTagValue(principalResponse.xml, "current-user-principal"));
if (!principalHref) throw new Error("Could not discover iCloud CalDAV principal URL.");
const principalUrl = resolveDavUrl(principalHref, principalResponse.url);

const homeResponse = await propfind(principalUrl, `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set /></D:prop>
</D:propfind>`);

const homeHref = hrefFrom(firstTagValue(homeResponse.xml, "calendar-home-set"));
if (!homeHref) throw new Error("Could not discover iCloud calendar home set.");
const homeUrl = resolveDavUrl(homeHref, homeResponse.url);

const collectionsResponse = await propfind(homeUrl, `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/">
  <D:prop>
    <D:displayname />
    <C:supported-calendar-component-set />
    <I:calendar-color />
  </D:prop>
</D:propfind>`, "1");

const responses = [...collectionsResponse.xml.matchAll(/<[^>]*:?response\b[\s\S]*?<\/[^>]*:?response>/gi)].map((match) => match[0]);
const lists = responses.map((block) => {
  const href = hrefFrom(block);
  const name = firstTagValue(block, "displayname") || "Reminders";
  const color = firstTagValue(block, "calendar-color") || "#22c55e";
  const supportsTodo = /<[^>]*:?comp\b[^>]*name=["']VTODO["']/i.test(block);
  return {
    name,
    color: color.slice(0, 7),
    url: href ? resolveDavUrl(href, collectionsResponse.url) : "",
    supportsTodo
  };
}).filter((list) => list.url && list.supportsTodo);

if (!lists.length) {
  console.error("No CalDAV VTODO reminder lists were found on this Apple account.");
  console.error("If your Reminders are not exposed through iCloud CalDAV, this app cannot read them yet.");
  process.exit(2);
}

console.log(JSON.stringify({
  appleReminders: {
    enabled: true,
    username,
    appPassword: "PASTE_APP_SPECIFIC_PASSWORD_HERE",
    lists: lists.map(({ name, color, url }) => ({ name, color, url }))
  }
}, null, 2));
