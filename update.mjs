// Обновляет data.js и картинки планировок с сайта Брусники (квартал «Издание», complex=83).
// Запуск: node update.mjs  (Node 18+, без зависимостей)
import fs from "node:fs";
import vm from "node:vm";

const BASE = "https://moskva.brusnika.ru";
const COMPLEX = 83;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const IMG = { planhd: "main_flat_image", dim: "flat7_image_file", floor: "floor_image_file" };

async function get(url, as = "text") {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(r.status + " " + url);
      return as === "json" ? r.json() : as === "buf" ? Buffer.from(await r.arrayBuffer()) : r.text();
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise(ok => setTimeout(ok, 3000));
    }
  }
}

// Список: is_booked=true отдаёт и свободные, и забронированные; проданных в нём нет.
async function listFlats() {
  const d = await get(`${BASE}/api/filter/flats/?offset=0&limit=1000&ordering=price_order&is_group=0&is_booked=true&complex=${COMPLEX}`, "json");
  if (d.results.length !== d.count) throw new Error(`API отдал ${d.results.length} из ${d.count}`);
  return [...new Map(d.results.map(l => [l.flat_id, l])).values()];
}

// Страница квартиры отрендерена Nuxt: данные лежат в window.__NUXT__ (минифицированная IIFE).
async function flatDetail(url) {
  const html = await get(url);
  const m = html.match(/<script>(window\.__NUXT__=[\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __NUXT__ in " + url);
  const ctx = { window: {} };
  vm.runInNewContext(m[1], ctx, { timeout: 2000 });
  const f = ctx.window.__NUXT__?.state?.flatDetail?.flat;
  if (!f?.id) throw new Error("no flat in " + url);
  return f;
}

const num = v => Number(v) || 0;

function toRecord(l, f) {
  const price = num(f.price);
  return {
    id: f.id,
    n: String(f.short_name),
    title: f.full_name,
    house: l.building_name,
    sec: String(f.section?.number ?? l.section_number),
    floor: f.floor,
    floors: f.max_floor,
    onFloor: String(f.number_on_floor),
    rooms: f.rooms,
    area: num(f.square),
    living: num(f.living_square),
    kitchen: num(f.kitchen_square),
    price,
    promo: num(f.price_package_marketing) || price,
    status: f.status,
    done: (l.delivery_title || "").replace(/^Срок сдачи:\s*/, ""),
    code: f.code,
    layout: f.name,
    url: f.page_url,
    balc: f.balconies_count || 0,
    logg: f.loggias_count || 0,
    wc: (f.combined_wcs_count || 0) + (f.separate_wcs_count || 0),
    tags: [...(f.red_tags || []), ...(f.tags || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(t => t.name),
    img: Object.keys(IMG).filter(k => f[IMG[k]]),
  };
}

// Картинку из CDN берём через их imgproxy сразу в webp; качаем только если файла ещё нет.
async function ensureImages(f, rec) {
  for (const k of rec.img) {
    const path = `img/${k}_${f.id}.webp`;
    if (fs.existsSync(path)) continue;
    const src = f[IMG[k]].replace("https://cdn.brusnika.ru/", "https://storage.yandexcloud.net/brusnika/");
    const b64 = Buffer.from(src).toString("base64url");
    const buf = await get(`https://cdn.brusnika.ru/proxy/insecure/rt:fit/w:2000/h:2000/g:sm/pd:60/bg:255:255:255/${b64}.webp`, "buf");
    fs.writeFileSync(path, buf);
    console.log("  + " + path);
  }
}

const list = await listFlats();
if (list.length < 10) throw new Error("подозрительно мало квартир: " + list.length + " — data.js не трогаю");

// Цены и статус есть в списке (сверено со страницами квартир). Страницу квартиры открываем
// только для новых лотов и при FULL=1 (раз в сутки: теги, площади, картинки).
const oldJs = fs.readFileSync("data.js", "utf8");
const old = new Map(JSON.parse(oldJs.split("window.IZD_FLATS=")[1].trim().replace(/;$/, "")).map(f => [f.id, f]));
const full = process.env.FULL === "1" || process.env.FULL === "true";

const flats = [];
for (const l of list) {
  const prev = old.get(l.flat_id);
  if (prev && !full) {
    const price = num(l.price);
    flats.push({ ...prev,
      price,
      promo: num(l.price_package_marketing) || price,
      status: l.is_booked ? "Забронирована" : "Свободна",
      done: (l.delivery_title || "").replace(/^Срок сдачи:\s*/, "") || prev.done });
    continue;
  }
  const f = await flatDetail(l.page_url);
  const rec = toRecord(l, f);
  await ensureImages(f, rec);
  flats.push(rec);
  if (!prev) console.log("новый лот: " + rec.id);
}
for (const id of old.keys()) if (!flats.some(f => f.id === id)) console.log("снят с продажи: " + id);

// Флаг для workflow: коммитим только когда изменились сами квартиры, а не время проверки.
const body = flats.map(f => JSON.stringify(f)).join(",\n");
if (!oldJs.includes("window.IZD_FLATS=[" + body + "];")) fs.writeFileSync(".changed", "");

const now = new Date(Date.now() + 3 * 3600e3); // московское время
const meta = { updated: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 16), source: `${BASE}/flat/?complex=${COMPLEX}` };
fs.writeFileSync("data.js",
  "window.IZD_META=" + JSON.stringify(meta) + ";\nwindow.IZD_FLATS=[" + body + "];\n");

// Картинки проданных квартир больше не нужны.
const keep = new Set(flats.flatMap(f => f.img.map(k => `${k}_${f.id}.webp`)));
for (const name of fs.readdirSync("img")) if (!keep.has(name)) fs.unlinkSync("img/" + name);

console.log(`квартир: ${flats.length}, свободных: ${flats.filter(f => f.status === "Свободна").length}`);
