#!/usr/bin/env node
/**
 * Pull every SBPEL website database out of Notion and write the two data files
 * the site reads: data/content.json and data/publications.json.
 *
 * Databases are found by title through the Notion search API, so adding a new
 * one needs no new secret — it only has to live under a page the integration
 * is connected to.
 *
 *   SBPEL Publications   →  publications.json  (Journal / Patent / News)
 *   SBPEL People         →  content.people
 *   SBPEL Research       →  content.research.topics
 *   SBPEL Gallery        →  content.gallery
 *   SBPEL Site           →  content.site  +  research overview fields
 *
 * Every property is read tolerantly: a column left as plain Text after a CSV
 * import works exactly like the matching Number / Select / Date / Checkbox
 * column, so no property types have to be converted by hand.
 *
 * Environment: NOTION_TOKEN (required), NOTION_DATABASE_ID (optional fallback
 * for the publications database), NOTION_VERSION (default 2022-06-28).
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TOKEN   = process.env.NOTION_TOKEN;
const VERSION = process.env.NOTION_VERSION || '2022-06-28';
const API     = process.env.NOTION_API_BASE || 'https://api.notion.com/v1';
const IMG_DIR = 'assets/img';

if (!TOKEN) {
  console.error('Missing NOTION_TOKEN.');
  process.exit(1);
}

/* ------------------------------------------------------------------ Notion */

async function notion(pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Notion API ${res.status} on ${pathname}: ${json.message || res.statusText}`);
    if (res.status === 404) {
      console.error('→ Share the page with your integration (Notion page ⋯ → Connections).');
    }
    process.exit(1);
  }
  return json;
}

async function findDatabases() {
  const found = [];
  let cursor;
  do {
    const page = await notion('/search', {
      filter: { property: 'object', value: 'database' },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    page.results.forEach((db) => {
      const title = (db.title || []).map((t) => t.plain_text).join('').trim();
      const cols = new Set(Object.keys(db.properties || {}).map((k) => k.toLowerCase()));
      found.push({ id: db.id, title, cols });
    });
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return found;
}

async function queryAll(id) {
  const rows = [];
  let cursor;
  do {
    const page = await notion(`/databases/${id}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/* ------------------------------------------------- tolerant property reads */

const parts = (p) => p?.rich_text || p?.title || [];

/** Rich text → HTML, keeping italic / bold written in Notion. */
function html(p) {
  return parts(p)
    .map((t) => {
      let s = (t.plain_text || '');
      // text that already carries <i>/<b> markup (e.g. from a CSV import) is kept as-is
      const markup = /<\/?(i|b|em|strong|sub|sup|br)\b/i.test(s);
      if (!markup) s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const a = t.annotations || {};
      if (a.italic) s = `<i>${s}</i>`;
      if (a.bold) s = `<b>${s}</b>`;
      if (t.href) s = `<a href="${t.href}">${s}</a>`;
      return s;
    })
    .join('');
}

const text = (p) => parts(p).map((t) => t.plain_text).join('').trim();

function pick(props, ...names) {
  for (const n of names) {
    const key = Object.keys(props).find((k) => k.toLowerCase() === n.toLowerCase());
    if (key) return props[key];
  }
  return undefined;
}

function num(p) {
  if (typeof p?.number === 'number') return p.number;
  const t = text(p).replace(/[^\d.-]/g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function sel(p) {
  if (p?.select?.name) return p.select.name;
  if (p?.status?.name) return p.status.name;
  if (Array.isArray(p?.multi_select) && p.multi_select.length) return p.multi_select[0].name;
  return text(p);
}

function bool(p) {
  if (!p) return true;
  if (typeof p.checkbox === 'boolean') return p.checkbox;
  const t = text(p).toLowerCase();
  if (!t) return true;
  return !(t === 'no' || t === 'false' || t === '0' || t === 'n' || t === 'off');
}

function dateOf(p) {
  if (p?.date?.start) return p.date.start;
  const t = text(p);
  return /^\d{4}-\d{2}(-\d{2})?/.test(t) ? t : '';
}

const url = (p) => p?.url || text(p) || '';

/** Every file in a Files & media cell, or URLs typed into a text cell. */
function fileUrls(p) {
  if (Array.isArray(p?.files) && p.files.length) {
    return p.files
      .map((f) => (f.type === 'external' ? f.external?.url : f.file?.url))
      .filter(Boolean);
  }
  const t = url(p);
  return t ? t.split(/[\s,]+/).filter((u) => /^https?:\/\//.test(u)) : [];
}

/** Split a multi-value text cell written as "a || b || c". */
const lines = (p) => html(p).split(/\s*\|\|\s*/).map((s) => s.trim()).filter(Boolean);

/* ------------------------------------------------------------------ images */

const seen = new Map();

/**
 * Notion serves uploaded files through signed URLs that expire within the hour,
 * so anything stored in Notion is copied into the repo. The local name is derived
 * from the row id, not the URL, so it stays stable between runs and the file is
 * not re-committed every time.
 */
async function localise(src, key) {
  if (!src) return '';
  if (!/amazonaws\.com|notion-static|secure\.notion/.test(src)) return src;
  if (seen.has(key)) return seen.get(key);
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(String(res.status));
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (new URL(src).pathname.match(/\.(jpe?g|png|webp|gif|avif|svg)$/i) || [, 'jpg'])[1].toLowerCase();
    const name = `${createHash('sha1').update(key).digest('hex').slice(0, 12)}.${ext}`;
    await mkdir(IMG_DIR, { recursive: true });
    await writeFile(path.join(IMG_DIR, name), buf);
    const rel = `${IMG_DIR}/${name}`;
    seen.set(key, rel);
    return rel;
  } catch (e) {
    console.warn(`  ! image download failed (${key}): ${e.message}`);
    return '';
  }
}

const firstImage = async (p, key) => localise(fileUrls(p)[0] || '', key);

async function allImages(p, key) {
  const urls = fileUrls(p);
  const out = [];
  for (let i = 0; i < urls.length; i++) out.push(await localise(urls[i], `${key}:${i}`));
  return out.filter(Boolean);
}

/* ------------------------------------------------------------------- build */

const dbs = await findDatabases();
console.log(`Databases visible to the integration: ${dbs.length}`);
dbs.forEach((d) => console.log(`  · ${d.title || '(untitled)'}  [${[...d.cols].join(', ')}]`));

/** Databases are matched on their title, and — because a table pasted into a page
 *  starts out untitled — also on the columns they carry, so naming is optional. */
const SIGNATURE = {
  publications: (c) => c.has('type') && (c.has('journal') || c.has('doi') || c.has('citation')),
  people:       (c) => c.has('group') && (c.has('role') || c.has('info')),
  research:     (c) => c.has('layout') && c.has('body') && !c.has('photos'),
  gallery:      (c) => c.has('photos') || (c.has('layout') && c.has('year') && c.has('body')),
  site:         (c) => c.has('key') && (c.has('text') || c.has('image')),
};

function locate(kind, ...words) {
  const byTitle = dbs.filter((d) => words.every((w) => d.title.toLowerCase().includes(w)));
  const test = SIGNATURE[kind];
  const bySig = test ? dbs.filter((d) => test(d.cols)) : [];
  const ids = new Set([...byTitle, ...bySig].map((d) => d.id));
  return [...ids];
}

const fallback = (process.env.NOTION_DATABASE_ID || '').replace(/-/g, '');
const ID = {
  publications: locate('publications', 'publication'),
  people:       locate('people', 'people'),
  research:     locate('research', 'research'),
  gallery:      locate('gallery', 'gallery'),
  site:         locate('site', 'site'),
};
if (!ID.publications.length && fallback) ID.publications = [fallback];
// a table can only belong to one kind: publications wins over the looser signatures
for (const k of ['people', 'research', 'gallery', 'site']) {
  ID[k] = ID[k].filter((id) => !ID.publications.includes(id));
}
ID.research = ID.research.filter((id) => !ID.gallery.includes(id));

async function rowsOf(ids, label) {
  if (!ids || !ids.length) { console.log(`  (no ${label} database found — skipping)`); return []; }
  const all = [];
  for (const id of ids) all.push(...(await queryAll(id)));
  console.log(`  ${label}: ${all.length} row(s) from ${ids.length} table(s)`);
  return all.filter((r) => bool(pick(r.properties || {}, 'Show', 'Published', 'Publish')));
}

/* ---- publications ---- */
const pubItems = [];
for (const page of await rowsOf(ID.publications, 'publications')) {
  const p = page.properties || {};
  const title = html(pick(p, 'Title', 'Name'));
  if (!title) continue;
  const type = (sel(pick(p, 'Type', 'Category')) || 'Journal').toLowerCase();
  if (type === 'news') {
    pubItems.push({
      type: 'news',
      date: dateOf(pick(p, 'Date')),
      title,
      body: html(pick(p, 'Body', 'Description')),
      url: url(pick(p, 'Link', 'URL')),
      image: await firstImage(pick(p, 'Image', 'Photo'), page.id + ':image'),
    });
    continue;
  }
  pubItems.push({
    type,
    year: num(pick(p, 'Year')) ?? null,
    title,
    authors: html(pick(p, 'Authors', 'Author')),
    journal: html(pick(p, 'Journal', 'Venue', 'Office')),
    citation: html(pick(p, 'Citation', 'Volume', 'Number')),
    doi: text(pick(p, 'DOI')).replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
    url: url(pick(p, 'Link', 'URL')),
    tag: sel(pick(p, 'Tag', 'Kind')).toLowerCase(),
  });
}

/* ---- people ---- */
const peopleRows = [];
for (const page of await rowsOf(ID.people, 'people')) {
  const p = page.properties || {};
  const name = html(pick(p, 'Name', 'Title'));
  if (!name) continue;
  peopleRows.push({
    name,
    group: (sel(pick(p, 'Group', 'Category')) || 'Graduate').toLowerCase(),
    order: num(pick(p, 'Order')) ?? 999,
    role: html(pick(p, 'Role', 'Position')),
    email: text(pick(p, 'Email')),
    research: lines(pick(p, 'Research', 'Topic')),
    info: html(pick(p, 'Info', 'Period')),
    affil: html(pick(p, 'Affiliation', 'Affil')),
    address: html(pick(p, 'Address')),
    contact: html(pick(p, 'Contact')),
    linksRaw: text(pick(p, 'Links')),
    cv: lines(pick(p, 'CV', 'History')),
    photo: await firstImage(pick(p, 'Photo', 'Image'), page.id + ':photo'),
  });
}
peopleRows.sort((a, b) => a.order - b.order);

const piRow = peopleRows.find((r) => r.group === 'pi');
const people = {
  pi: piRow ? {
    name: piRow.name, title: piRow.role, photo: piRow.photo,
    affil: piRow.affil, address: piRow.address, contact: piRow.contact,
    links: piRow.linksRaw.split(/\s*;\s*/).filter(Boolean)
             .map((s) => { const [l, u] = s.split('|'); return [(l || '').trim(), (u || '').trim()]; }),
    cv: piRow.cv,
  } : {},
  members: peopleRows.filter((r) => ['graduate', 'undergraduate', 'researcher', 'postdoc'].includes(r.group))
             .map((r) => ({ name: r.name, role: r.role, email: r.email, research: r.research, photo: r.photo })),
  alumni: peopleRows.filter((r) => r.group === 'alumni').map((r) => ({ name: r.name, info: r.info })),
  former: peopleRows.filter((r) => r.group === 'former').map((r) => ({ name: r.name, info: r.info })),
};

/* ---- research ---- */
const topics = [];
for (const page of await rowsOf(ID.research, 'research')) {
  const p = page.properties || {};
  const title = html(pick(p, 'Title', 'Name'));
  if (!title) continue;
  topics.push({
    order: num(pick(p, 'Order')) ?? 999,
    title,
    body: html(pick(p, 'Body', 'Description')),
    hint: text(pick(p, 'Hint')),
    layout: (sel(pick(p, 'Layout')) || 'full').toLowerCase(),
    figure: await firstImage(pick(p, 'Figure', 'Image'), page.id + ':figure'),
  });
}
topics.sort((a, b) => a.order - b.order);

/* ---- gallery ---- */
const gallery = [];
for (const page of await rowsOf(ID.gallery, 'gallery')) {
  const p = page.properties || {};
  const title = html(pick(p, 'Title', 'Name'));
  const order = num(pick(p, 'Order')) ?? 999;
  gallery.push({
    order, title,
    year: text(pick(p, 'Year')),
    body: html(pick(p, 'Body', 'Description')),
    layout: (sel(pick(p, 'Layout')) || 'center').toLowerCase(),
    photos: await allImages(pick(p, 'Photos', 'Photo', 'Images'), page.id + ':photos'),
  });
}
gallery.sort((a, b) => a.order - b.order);

/* ---- site ---- */
const S = {};
for (const page of await rowsOf(ID.site, 'site')) {
  const p = page.properties || {};
  const key = text(pick(p, 'Key', 'Name', 'Title'));
  if (!key) continue;
  S[key] = {
    text: html(pick(p, 'Text', 'Value')),
    plain: text(pick(p, 'Text', 'Value')),
    image: await firstImage(pick(p, 'Image', 'File', 'Photo'), page.id + ':image'),
  };
}
const sv  = (k, d = '') => (S[k] ? (S[k].text || S[k].image || d) : d);
const sim = (k) => (S[k] ? (S[k].image || S[k].plain || '') : '');
const sls = (k) => (S[k] ? S[k].text.split(/\s*\|\|\s*/).map((s) => s.trim()).filter(Boolean) : []);

const content = {
  generated: new Date().toISOString(),
  source: 'notion',
  site: {
    short_name: S.short_name ? S.short_name.plain : 'KANG LAB',
    lab_name: sv('lab_name', 'Synthetic Biology and BioProcess Engineering Lab'),
    logo: sim('logo'),
    khu_logo: sim('khu_logo'),
    banners: {
      home: sim('banner_home'), research: sim('banner_research'), people: sim('banner_people'),
      publications: sim('banner_publications'), gallery: sim('banner_gallery'),
    },
    home_welcome: sv('home_welcome', 'Welcome to the KANG Lab!'),
    home_intro: sv('home_intro'),
    home_figure: sim('home_figure'),
    contacts_title: sv('contacts_title', 'Contacts'),
    contacts_lines: sls('contacts_lines'),
    footer_lines: sls('footer_lines'),
  },
  research: {
    overview_title: sv('research_overview_title', 'Research Overview'),
    overview_sub: sv('research_overview_sub'),
    overview_figure: sim('research_overview_figure'),
    intro: sv('research_intro'),
    topics: topics.map(({ order, ...t }) => t),
  },
  people,
  gallery: gallery.map(({ order, ...g }) => g),
};

const pubs = {
  generated: content.generated,
  source: 'notion',
  counts: pubItems.reduce((a, i) => ((a[i.type] = (a[i.type] || 0) + 1), a), {}),
  items: pubItems,
};

/* ------------------------------------------------------------------- write */

async function save(file, obj) {
  const next = JSON.stringify(obj, null, 1);
  const prev = await readFile(file, 'utf8').catch(() => '');
  const strip = (s) => s.replace(/"generated":\s*"[^"]*",?/, '');
  if (prev && strip(prev) === strip(next)) {
    console.log(`No change — ${file} left untouched.`);
    return false;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next + '\n', 'utf8');
  console.log(`Wrote ${file}`);
  return true;
}

const a = await save('data/publications.json', pubs);
const b = await save('data/content.json', content);
console.log(`publications: ${JSON.stringify(pubs.counts)}  ·  people: ${people.members.length} members` +
            `  ·  research: ${topics.length} topics  ·  gallery: ${gallery.length} items`);
if (!a && !b) console.log('Nothing to commit.');
