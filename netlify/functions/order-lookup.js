// netlify/functions/order-lookup.js
//
// Server-side order lookup for the Returns app and the Returns Matcher.
// Reads Shopify orders from the `sales_orders` / `sales_order_lines` tables in the
// baboodle-erp Supabase project (ref zatjokylncxbeppwzqxu). Those tables are server-only
// (row level security on, no public access), so this function uses the service role key.
//
// REQUIRED Netlify environment variable (Site configuration -> Environment variables):
//   ERP_SERVICE_ROLE_KEY   the baboodle-erp service role key
// OPTIONAL:
//   ERP_SUPABASE_URL       defaults to https://zatjokylncxbeppwzqxu.supabase.co
//   ALLOWED_ORIGINS        comma-separated extra origins allowed to call this function,
//                          e.g. https://your-matcher-site.netlify.app
//                          (only needed if the Matcher lives on a different Netlify site)
//
// Deliberately narrow: lookups by exact order number / email / id, plus a batch match for
// the Matcher. Only the handful of fields the apps need are returned. The full Shopify
// `raw` copy, payment and fraud data, phone numbers and street addresses never leave here.

const ERP_URL = process.env.ERP_SUPABASE_URL || 'https://zatjokylncxbeppwzqxu.supabase.co';
const ERP_KEY = process.env.ERP_SERVICE_ROLE_KEY;
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const ORDER_FIELDS = 'id,name,customer_email,customer_name,shipping_name,shipping_zip,fulfillment_status,tags';
const EXCLUDED_ITEMS = ['baboodle subscription'];
const MAX_BATCH_ROWS = 150;

// ---------- helpers ----------

function corsHeaders(event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function json(event, statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(event) },
    body: JSON.stringify(body)
  };
}

function originAllowed(event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin;
  if (!origin) return true;
  const host = h.host || h.Host;
  try {
    const u = new URL(origin);
    return u.host === host || u.hostname === 'localhost' || EXTRA_ORIGINS.includes(u.origin);
  } catch (e) {
    return false;
  }
}

async function rest(path) {
  const res = await fetch(`${ERP_URL}/rest/v1/${path}`, {
    headers: { apikey: ERP_KEY, Authorization: `Bearer ${ERP_KEY}` }
  });
  if (!res.ok) {
    throw new Error(`ERP request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Pages through a query (the database caps each response at 1000 rows).
// `path` must include a stable `order=` so pages don't overlap.
async function restAll(path, pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await rest(`${path}&limit=${pageSize}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < pageSize || out.length >= 20000) break;
  }
  return out;
}

// Builds the inside of an `in.(...)` filter. Plain values go unquoted; anything with
// punctuation that could confuse the parser is double-quoted.
function inList(values) {
  return values
    .map(v => /^[A-Za-z0-9#_.@+-]+$/.test(v)
      ? encodeURIComponent(v)
      : `%22${encodeURIComponent(String(v).replace(/"/g, ''))}%22`)
    .join(',');
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// Same order shape the apps already expect, plus order_name / full_name / postcode,
// which the confirm and success screens use as fallbacks.
function shape(o) {
  const tags = Array.isArray(o.tags) ? o.tags : [];
  return {
    id: o.id,
    order_number: o.name,
    order_name: o.name,
    customer_email: o.customer_email,
    full_name: o.shipping_name || o.customer_name || null,
    postcode: o.shipping_zip || null,
    fulfillment_status: o.fulfillment_status,
    tags: tags.join(', ')
  };
}

function isRecurring(o) {
  return (Array.isArray(o.tags) ? o.tags : []).some(t => /recurring order/i.test(t));
}

// Order numbers arrive in lots of shapes (B-47231, B47231, b-47231, "B 47231", 47231, #47231).
// Returns the likely names in sales_orders, best guess first.
function nameCandidates(input) {
  const raw = String(input || '').trim();
  const out = [];
  const add = v => { if (v && !out.includes(v)) out.push(v); };
  add(raw);
  const m = raw.toUpperCase().replace(/[\s#-]/g, '').match(/^([A-Z]*)(\d+)$/);
  if (m) {
    const letters = m[1];
    const digits = m[2];
    add(`${letters || 'B'}-${digits}`);
    add(`#${digits}`);
  }
  return out;
}

const normPostcode = p => String(p || '').replace(/\s/g, '').toUpperCase();

function validEmail(e) {
  const s = String(e || '').trim();
  return s.length > 3 && s.length < 200 && s.includes('@');
}

// A name is only safe to put in an ilike filter if it has no wildcard / syntax characters.
function cleanName(n) {
  const s = String(n || '').trim().replace(/\s+/g, ' ');
  if (s.length < 3 || s.length > 80 || /[,()%*_"\\]/.test(s)) return '';
  return s;
}

async function addItems(orders) {
  if (!orders.length) return orders;
  const ids = orders.map(o => o.id).join(',');
  const lines = await restAll(`sales_order_lines?select=order_id,title,variant_title&order_id=in.(${ids})&order=id.asc`);
  const byOrder = {};
  for (const l of lines) {
    (byOrder[l.order_id] = byOrder[l.order_id] || []).push(l.title || '');
  }
  return orders.map(o => ({ ...o, items: (byOrder[o.id] || []).filter(Boolean) }));
}

// Same item text the Matcher used to build from the CSV: "2x Name (Variant)".
function itemText(l) {
  const title = String(l.title || '').trim();
  if (!title) return '';
  if (EXCLUDED_ITEMS.some(x => title.toLowerCase().includes(x))) return '';
  const qty = Number(l.quantity);
  const q = qty && qty !== 1 ? `${qty}x ` : '';
  const variant = String(l.variant_title || '').trim();
  const v = variant && variant !== 'Default Title' ? ` (${variant})` : '';
  return q + title + v;
}

// ---------- batch match for the Returns Matcher ----------
// rows: [{ k: trackingNumber, o: orderNumber, e: email, n: name, p: postcode }]
// Match order: 1) order number  2) customer email  3) name (+ postcode to prefer)
// Returns { [k]: { mt: 'matched'|'partial'|'unmatched', on, email, items } }
async function matchBatch(rows) {
  rows = rows.slice(0, MAX_BATCH_ROWS);
  const chosen = {};

  // 1) order number
  const rowCands = rows.map(r => nameCandidates(r.o));
  const allNames = [...new Set(rowCands.flat())].filter(Boolean);
  if (allNames.length) {
    const found = await restAll(
      `sales_orders?select=${ORDER_FIELDS}&name=in.(${inList(allNames)})&id=gt.1000000&order=id.desc`
    );
    const byName = {};
    for (const o of found) (byName[o.name] = byName[o.name] || []).push(o);
    rows.forEach((r, i) => {
      for (const c of rowCands[i]) {
        if (byName[c] && byName[c].length) { chosen[r.k] = { order: byName[c][0], mt: 'matched' }; break; }
      }
    });
  }

  // 2) customer email: latest non-recurring order, else latest order
  const needEmail = rows.filter(r => !chosen[r.k] && validEmail(r.e));
  const emails = [...new Set(needEmail.map(r => String(r.e).trim().toLowerCase()))];
  if (emails.length) {
    const found = await restAll(
      `sales_orders?select=${ORDER_FIELDS}&customer_email=in.(${inList(emails)})&id=gt.1000000&order=id.desc`
    );
    const byEmail = {};
    for (const o of found) (byEmail[o.customer_email] = byEmail[o.customer_email] || []).push(o);
    for (const r of needEmail) {
      const list = byEmail[String(r.e).trim().toLowerCase()];
      if (list && list.length) chosen[r.k] = { order: list.find(o => !isRecurring(o)) || list[0], mt: 'matched' };
    }
  }

  // 3) name, preferring the one whose postcode also matches
  const needName = rows.filter(r => !chosen[r.k] && cleanName(r.n));
  await mapLimit(needName, 5, async r => {
    const n = encodeURIComponent(cleanName(r.n));
    const all = await rest(
      `sales_orders?select=${ORDER_FIELDS}&or=(shipping_name.ilike.${n},customer_name.ilike.${n})&id=gt.1000000&order=id.desc&limit=30`
    );
    const list = all.filter(o => !isRecurring(o));
    if (!list.length) return;
    const pc = normPostcode(r.p);
    const byPostcode = pc ? list.filter(o => normPostcode(o.shipping_zip) === pc) : [];
    chosen[r.k] = { order: byPostcode[0] || list[0], mt: 'partial' };
  });

  // items for every chosen order
  const ids = [...new Set(Object.values(chosen).map(c => c.order.id))];
  const itemsByOrder = {};
  if (ids.length) {
    const lines = await restAll(
      `sales_order_lines?select=order_id,title,variant_title,quantity&order_id=in.(${ids.join(',')})&order=id.asc`
    );
    for (const l of lines) {
      const t = itemText(l);
      if (!t) continue;
      const arr = (itemsByOrder[l.order_id] = itemsByOrder[l.order_id] || []);
      if (!arr.includes(t)) arr.push(t);
    }
  }

  const out = {};
  for (const r of rows) {
    const c = chosen[r.k];
    out[r.k] = c
      ? { mt: c.mt, on: c.order.name, email: c.order.customer_email, items: (itemsByOrder[c.order.id] || []).join(', ') }
      : { mt: 'unmatched' };
  }
  return out;
}

// ---------- handler ----------

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return originAllowed(event)
      ? { statusCode: 204, headers: corsHeaders(event), body: '' }
      : { statusCode: 403, body: '' };
  }
  if (event.httpMethod !== 'POST') return json(event, 405, { error: 'POST only' });
  if (!originAllowed(event)) return json(event, 403, { error: 'Forbidden' });
  if (!ERP_KEY) return json(event, 500, { error: 'ERP_SERVICE_ROLE_KEY is not set on this Netlify site' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(event, 400, { error: 'Invalid JSON' }); }

  const action = body.action;
  const payload = body.payload || {};

  try {
    // 1) Exact order number (any of the usual formats)
    if (action === 'byOrderNumber') {
      const orderNumber = String(payload.orderNumber || '').trim();
      if (!orderNumber || orderNumber.length > 40) return json(event, 200, { data: null });
      const cands = nameCandidates(orderNumber);
      const rows = await rest(
        `sales_orders?select=${ORDER_FIELDS}&name=in.(${inList(cands)})&id=gt.1000000&order=id.desc&limit=10`
      );
      for (const c of cands) {
        const hit = rows.find(r => r.name === c);
        if (hit) return json(event, 200, { data: shape(hit) });
      }
      return json(event, 200, { data: null });
    }

    // 2) Latest non-recurring order for an email (fallback match)
    if (action === 'latestByEmail') {
      const email = String(payload.email || '').trim().toLowerCase();
      if (!validEmail(email)) return json(event, 200, { data: null });
      const rows = await rest(
        `sales_orders?select=${ORDER_FIELDS}&customer_email=eq.${encodeURIComponent(email)}&id=gt.1000000&order=id.desc&limit=100`
      );
      const hit = rows.find(r => !isRecurring(r));
      return json(event, 200, { data: hit ? shape(hit) : null });
    }

    // 3) All non-recurring orders for an email, with item titles ("Items don't match?")
    if (action === 'otherOrders') {
      const email = String(payload.email || '').trim().toLowerCase();
      if (!validEmail(email)) return json(event, 200, { data: [] });
      const rows = await rest(
        `sales_orders?select=${ORDER_FIELDS}&customer_email=eq.${encodeURIComponent(email)}&id=gt.1000000&order=id.desc&limit=100`
      );
      const orders = rows.filter(r => !isRecurring(r)).slice(0, 25);
      const withItems = await addItems(orders);
      return json(event, 200, { data: withItems.map(o => ({ ...shape(o), items: o.items })) });
    }

    // 4) One order by Shopify id (after staff pick a different order)
    if (action === 'byId') {
      const id = parseInt(payload.id, 10);
      if (!Number.isInteger(id) || id <= 0) return json(event, 200, { data: null });
      const rows = await rest(`sales_orders?select=${ORDER_FIELDS}&id=eq.${id}&limit=1`);
      if (!rows.length) return json(event, 200, { data: null });
      const [withItems] = await addItems(rows);
      return json(event, 200, { data: { ...shape(withItems), items: withItems.items } });
    }

    // 5) Batch match for the Returns Matcher
    if (action === 'matchBatch') {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      const clean = rows
        .filter(r => r && r.k)
        .map(r => ({ k: String(r.k), o: String(r.o || ''), e: String(r.e || ''), n: String(r.n || ''), p: String(r.p || '') }));
      return json(event, 200, { data: await matchBatch(clean) });
    }

    // 6) When the orders database last synced from Shopify
    if (action === 'status') {
      const rows = await rest('sales_sync_state?select=value,updated_at&key=eq.orders_sync&limit=1');
      const row = rows[0];
      const lastRun = row ? ((row.value && row.value.lastRun) || row.updated_at) : null;
      return json(event, 200, { data: { lastRun } });
    }

    return json(event, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('order-lookup failed:', e.message);
    return json(event, 502, { error: 'Order lookup failed' });
  }
};
