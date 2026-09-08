#!/usr/bin/env node
/**
 * Pull the lab's unified Notion database into data/publications.json.
 *
 * Environment:
 *   NOTION_TOKEN        Internal integration secret (starts with "ntn_" or "secret_")
 *   NOTION_DATABASE_ID  32-character database id from the Notion URL
 *   NOTION_VERSION      optional, defaults to 2022-06-28
 *
 * Run locally:  NOTION_TOKEN=... NOTION_DATABASE_ID=... node scripts/sync-notion.mjs
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TOKEN = process.env.NOTION_TOKEN;
const DB = (process.env.NOTION_DATABASE_ID || '').replace(/-/g, '');
const VERSION = process.env.NOTION_VERSION || '2022-06-28';
const API = process.env.NOTION_API_BASE || 'https://api.notion.com/v1';
const OUT = process.env.NOTION_OUT || 'data/publications.json';
const IMG_DIR = 'assets/news';

if (!TOKEN || !DB) {
  console.error('Missing NOTION_TOKEN or NOTION_DATABASE_ID.');
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
    console.error(`Notion API ${res.status}: ${json.message || res.statusText}`);
    if (res.status === 404) {
      console.error('→ Check that the database is shared with your integration (Notion page ⋯ → Connections).');
    }
    process.exit(1);
  }
  return json;
}

async function queryAll() {
  const rows = [];
  let cursor;
  do {
    const page = await notion(`/databases/${DB}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/* --------------------------------------------------------------- mapping  */

/** Rich text → HTML, preserving italic / bold / sub / sup written in Notion. */
function rich(prop) {
  const parts = prop?.rich_text || prop?.title || [];
  return parts
    .map((t) => {
      let s = (t.plain_text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const a = t.annotations || {};
      if (a.italic) s = `<i>${s}</i>`;
      if (a.bold) s = `<b>${s}</b>`;
      if (a.code) s = `<span>${s}</span>`;
      if (t.href) s = `<a href="${t.href}">${s}</a>`;
      return s;
    })
    .join('');
}

const plain = (prop) =>
  (prop?.rich_text || prop?.title || []).map((t) => t.plain_text).join('').trim();

const pick = (props, ...names) => {
  for (const n of names) {
    const key = Object.keys(props).find((k) => k.toLowerCase() === n.toLowerCase());
    if (key) return props[key];
  }
  return undefined;
};

const selectName = (prop) => prop?.select?.name || prop?.status?.name || '';
const numberOf = (prop) => (typeof prop?.number === 'number' ? prop.number : null);
const urlOf = (prop) => prop?.url || (prop?.rich_text ? plain(prop) : '') || '';
const dateOf = (prop) => prop?.date?.start || '';
const checked = (prop) => (prop && typeof prop.checkbox === 'boolean' ? prop.checkbox : true);

function fileUrl(prop) {
  const f = (prop?.files || [])[0];
  if (!f) return '';
  return f.type === 'external' ? f.external?.url || '' : f.file?.url || '';
}

/**
 * Notion-hosted files are served through signed URLs that expire within the hour,
 * so anything uploaded into Notion is copied into the repo and referenced locally.
 */
async function localiseImage(url, id) {
  if (!url) return '';
  if (!/amazonaws\.com|notion-static|secure\.notion/.test(url)) return url; // external URL: use as-is
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i) || [, 'jpg'])[1].toLowerCase();
    const name = `${createHash('sha1').update(id).digest('hex').slice(0, 12)}.${ext}`;
    await mkdir(IMG_DIR, { recursive: true });
    await writeFile(path.join(IMG_DIR, name), buf);
    return `${IMG_DIR}/${name}`;
  } catch (e) {
    console.warn(`  ! image download failed (${id}): ${e.message}`);
    return '';
  }
}

/* ------------------------------------------------------------------- main */

const rows = await queryAll();
console.log(`Fetched ${rows.length} row(s) from Notion.`);

const items = [];
let skipped = 0;

for (const page of rows) {
  const p = page.properties || {};
  const title = rich(pick(p, 'Title', 'Name'));
  if (!title) { skipped++; continue; }
  if (!checked(pick(p, 'Show', 'Published', 'Publish'))) { skipped++; continue; }

  const type = (selectName(pick(p, 'Type', 'Category')) || 'Journal').toLowerCase();

  if (type === 'news') {
    const raw = fileUrl(pick(p, 'Image', 'Photo', 'Cover'));
    items.push({
      type: 'news',
      date: dateOf(pick(p, 'Date', 'Published on')) || '',
      title,
      body: rich(pick(p, 'Body', 'Description', 'Note')),
      url: urlOf(pick(p, 'Link', 'URL')),
      image: await localiseImage(raw, page.id),
    });
    continue;
  }

  const doi = plain(pick(p, 'DOI')).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  items.push({
    type,
    year: numberOf(pick(p, 'Year')) ?? (dateOf(pick(p, 'Date')) || '').slice(0, 4) ?? null,
    title,
    authors: rich(pick(p, 'Authors', 'Author')),
    journal: rich(pick(p, 'Journal', 'Venue', 'Office')),
    citation: rich(pick(p, 'Citation', 'Volume', 'Number')),
    doi,
    url: urlOf(pick(p, 'Link', 'URL')),
    tag: selectName(pick(p, 'Tag', 'Kind')).toLowerCase(),
  });
}

items.sort((a, b) => {
  if (a.type === 'news' || b.type === 'news') return 0;
  return (Number(b.year) || 0) - (Number(a.year) || 0);
});

const payload = {
  generated: new Date().toISOString(),
  source: 'notion',
  counts: items.reduce((acc, i) => ((acc[i.type] = (acc[i.type] || 0) + 1), acc), {}),
  items,
};

const next = JSON.stringify(payload, null, 1);
const prev = await readFile(OUT, 'utf8').catch(() => '');

// Ignore the timestamp when deciding whether anything actually changed,
// so the scheduled run does not create an empty commit every six hours.
const strip = (s) => s.replace(/"generated":\s*"[^"]*",?/, '');
if (prev && strip(prev) === strip(next)) {
  console.log('No content change — leaving', OUT, 'untouched.');
  process.exit(0);
}

await mkdir('data', { recursive: true });
await writeFile(OUT, next + '\n', 'utf8');
console.log(`Wrote ${OUT}: ${items.length} item(s)${skipped ? `, ${skipped} skipped` : ''}.`);
console.log('  ' + JSON.stringify(payload.counts));
