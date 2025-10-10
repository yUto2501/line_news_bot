import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import * as line from "@line/bot-sdk";
import Parser from "rss-parser";
import OpenAI from "openai";
import stringSimilarity from "string-similarity";

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
// ---- Group/Room ID を保存・読み書きする簡易ストア（ファイル保存）----
import fs from "fs";
import path from "path";

// ===== Google Sheets を使った Group/Room ID ストア =====
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const SHEET_NAME     = process.env.SHEETS_SHEET_NAME || "groups";
const SA_EMAIL       = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || ""

if (!SPREADSHEET_ID || !SA_EMAIL || !SA_PRIVATE_KEY) {
  console.warn("[GroupsStore] Sheets の環境変数が未設定です。保存は無効になります。");
}


let sheetsClient = null;
async function getSheets() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  // どちらのケースも吸収：Renderなどの `\n` / ローカルの実改行 / Windowsの CR を正規化
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")   // 文字列の \n を実改行に
    .replace(/\r/g, "")      // CR を除去
    .trim();                 // 前後空白除去

  if (!email || !key || !key.startsWith("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("Missing/invalid GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  }

  // ✅ 非推奨APIを使わず、JWT の“オブジェクト形式”で作る
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  await auth.authorize(); // ここでエラーが出なければOK
  return google.sheets({ version: "v4", auth });
}

async function readAllRows() {
  const api = await getSheets();
  if (!api) return [];
  const r = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:D`,
  });
  const rows = r.data.values || [];
  return rows
    .filter(row => row[0])
    .map(row => ({
      id: row[0],
      type: row[1] || "unknown",
      lastSeen: row[2] || "",
      isDefault: (row[3] || "").toString().toLowerCase() === "true",
    }));
}

async function upsertRow(id, type, lastSeenIso) {
  const api = await getSheets();
  if (!api) return;
  const rows = await readAllRows();
  const idx = rows.findIndex(r => r.id === id);
  if (idx >= 0) {
    // update
    const rowNum = idx + 2; // 1-based + header
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${rowNum}:C${rowNum}`,
      valueInputOption: "RAW",
      requestBody: { values: [[id, type, lastSeenIso]] },
    });
  } else {
    // append
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:D`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[id, type, lastSeenIso, "FALSE"]] },
    });
  }
}

async function setDefaultRow(id) {
  const api = await getSheets();
  if (!api) return;
  const rows = await readAllRows();
  // 全部 false に
  if (rows.length) {
    const values = rows.map(r => ["FALSE"]);
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!D2:D${rows.length + 1}`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }
  // id の行を true に（無ければ作って true）
  const idx = rows.findIndex(r => r.id === id);
  if (idx >= 0) {
    const rowNum = idx + 2;
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!D${rowNum}:D${rowNum}`,
      valueInputOption: "RAW",
      requestBody: { values: [["TRUE"]] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:D`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[id, "unknown", new Date().toISOString(), "TRUE"]] },
    });
  }
}





async function getAllGroupIds() {
  try {
    const api = await getSheets();
    if (!api) return [];

    // A2:D だとデータが無ければ undefined。空配列にフォールバック。
    const r = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:D`,
    });

    const rows = r.data.values || [];

    if (rows.length === 0) {
      console.warn("[GroupsStore] シートにデータ行がありません（ヘッダーのみ）");
      return [];
    }

    // A列(ID)が "C" で始まる（グループID）だけ抽出
    const ids = rows
      .map(row => row[0])
      .filter(id => typeof id === "string" && id.startsWith("C"));

    console.log(`[GroupsStore] getAllGroupIds -> ${ids.length}件`);
    return ids;
  } catch (e) {
    console.error("[GroupsStore] getAllGroupIds error:", e.message || e);
    return [];
  }
}




function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { defaultTo: null, groups: {} }; // groups: { [id]: { type: "group"|"room"|"user", lastSeen: ISO } }
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}
async function rememberSource(ev) {
  try {
    const src = ev?.source?.type;
    let id = null;
    if (src === "group") id = ev.source.groupId;
    else if (src === "room") id = ev.source.roomId;
    else if (src === "user") id = ev.source.userId;
    if (!id) return;
    await upsertRow(id, src, new Date(ev.timestamp || Date.now()).toISOString());
    const rows = await readAllRows();
    const hasDefault = rows.some(r => r.isDefault);
    if (!hasDefault && (src === "group" || src === "room")) {
      await setDefaultRow(id);
    }
  } catch (e) {
    console.error("[GroupsStore] rememberSource error:", e?.message || e);
  }
}

async function getDefaultTo() {
  const envTo = process.env.TEST_GROUP_ID || process.env.DEFAULT_TO;
  if (envTo) return envTo;
  const rows = await readAllRows();
  const def = rows.find(r => r.isDefault);
  return def?.id || rows[0]?.id || null;
}



// 個別記事の本文を抽出（最大 ~8000 文字にトリム）
async function fetchArticleText(url) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const html = await r.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const text = (article?.textContent || "").replace(/\s+\n/g, "\n").trim();
    // 余り長いとトークン超過するので制限
    return text.slice(0, 8000);
  } catch (e) {
    console.warn("fulltext error:", url, e.message || e);
    return "";
  }
}

// GoogleニュースRSSのリンクを元記事URLに展開（可能なら）
function fromGoogleNewsLink(link) {
  try {
    const u = new URL(link);
    if (u.hostname === "news.google.com") {
      // 形式1: https://news.google.com/rss/articles/.. の場合もあるが
      // 形式2: ...?url=実URL が付いていることがある
      const real = u.searchParams.get("url");
      if (real) return real;
    }
  } catch {}
  return link;
}

// --- 海外ソースの質を上げる設定 ---
// 強い許可ドメイン（一次情報・査読・大手行政）
const OVERSEAS_ALLOW = [
  "who.int","oecd.org","nih.gov","ninds.nih.gov","nlm.nih.gov","hhs.gov","cdc.gov","ema.europa.eu","nhs.uk",
  "nature.com","thelancet.com","nejm.org","bmj.com","jamanetwork.com","medrxiv.org","arxiv.org",
  "stanford.edu","harvard.edu","ox.ac.uk","cam.ac.uk","imperial.ac.uk","ucl.ac.uk","mit.edu",
  "mayoclinic.org","clevelandclinic.org","massgeneral.org","kuh.ac.kr","singhealth.com.sg"
];

// 準allow（大手テック/医療IT系の公式ブログ等）
const OVERSEAS_SEMIALLOW = [
  "healthit.gov","whoop.com","philips.com","gehealthcare.com","siemens-healthineers.com","nvidia.com","microsoft.com","googleblog.com","openai.com"
];

// 除外ドメイン（転載/PR配信/アフィ色が濃い等）※必要に応じて増やしてください
const AVOID_DOMAINS = [
  "medium.com","pinterest.com","linkedin.com","facebook.com","x.com","twitter.com",
  "businesswire.com","prnewswire.com","globenewswire.com","newswire.com","einnews.com",
  "apnews.com/press-release","marketwatch.com/press-release","benzinga.com/pressreleases"
];

// 媒体信頼スコア（ドメイン末尾でマッチ、無い場合は0）
const TRUST_WEIGHTS = {
  "who.int": 4, "oecd.org": 3, "nih.gov": 4, "hhs.gov": 3, "cdc.gov": 4, "ema.europa.eu": 4, "nhs.uk": 4,
  "nature.com": 5, "thelancet.com": 5, "nejm.org": 5, "bmj.com": 5, "jamanetwork.com": 5,
  "medrxiv.org": 3, "arxiv.org": 3,
  "stanford.edu": 4, "harvard.edu": 4, "ox.ac.uk": 4, "cam.ac.uk": 4, "imperial.ac.uk": 4, "ucl.ac.uk": 4, "mit.edu": 4,
  "mayoclinic.org": 4, "clevelandclinic.org": 4, "massgeneral.org": 4,
  "healthit.gov": 3, "nvidia.com": 2, "microsoft.com": 2, "googleblog.com": 2, "openai.com": 2
};

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}
function domainIn(list, url) {
  const h = hostOf(url);
  return list.some(d => h === d || h.endsWith("."+d));
}
function trustOf(url) {
  const h = hostOf(url);
  let best = 0;
  for (const [dom, w] of Object.entries(TRUST_WEIGHTS)) {
    if (h === dom || h.endsWith("."+dom)) best = Math.max(best, w);
  }
  return best; // 0〜5
}


// 国内/海外判定（regionが付いていれば優先。なければTLDで判定）
const JP_TLDS = [".jp", ".go.jp", ".lg.jp", ".co.jp", ".or.jp", ".ne.jp"];
const JP_EXCEPT = ["japantimes.co.jp"]; // 英語でも国内扱い
function isDomesticByTLD(url) {
  try {
    const u = new URL(url);
    if (JP_EXCEPT.some(d => u.hostname.endsWith(d))) return true;
    return JP_TLDS.some(t => u.hostname.endsWith(t));
  } catch { return false; }
}
function decideDomestic(item) {
  if (item.region === "domestic") return true;
  if (item.region === "overseas") return false;
  return isDomesticByTLD(item.link);
}


const parser = new Parser();
const { Client } = line;

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  NEWSAPI_KEY,
  OPENAI_API_KEY,
  TOPIC = "高齢者医療×AI/IT",
  PORT = 8080,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN missing");
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

const lineClient = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();

// ---- 設定 ----
const JST = 9 * 60; // minutes
const now = () => new Date(Date.now());
const daysAgo = (n) => new Date(now().getTime() - n * 86400000);
const SINCE = daysAgo(7);

// RSS（例：省庁/医療/IT）※必要に応じて増減
const FEEDS = [
  // 国内（.jp優先）     // 厚労省 EN
  "https://www.mhlw.go.jp/stf/news.rdf",                // 厚労省 JP
  "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml",  // ITmedia ニュース速報
];

// 高齢者/介護ワード + AI/ITワード
const ELDER_KEYS = ["高齢者","介護","老人","在宅医療","地域包括","見守り","転倒","認知症","介護保険","介護DX","シルバー","geriatric","elderly","seniors","older adults","nursing home","care home","long-term care"];
const AIIT_KEYS   = ["AI","人工知能","生成AI","機械学習","デジタルヘルス","遠隔診療","リモートモニタリング","転倒検知","センサー","見守りシステム","telemedicine","digital health","machine learning","LLM","gen AI","remote monitoring","fall detection"];

// 国内/海外判定（簡易）
//const JP_TLDS = [".jp",".go.jp",".lg.jp"];
//const JP_EXCEPT = ["japantimes.co.jp"]; // 英字でも国内扱いにしたいドメイン
const isDomestic = (url) => {
  try {
    const u = new URL(url);
    return JP_TLDS.some(t => u.hostname.endsWith(t)) || JP_EXCEPT.some(d => u.hostname.endsWith(d));
  } catch { return false; }
};

// URL正規化
const normalizeUrl = (u) => (u || "").replace(/#.*$/,"").replace(/([?&])utm_[^&]+/g,"").replace(/[?&]$/,"");

// 期間フィルタ（JST基準）
const inLast7Days = (iso) => {
  if (!iso) return false;
  const d = new Date(iso);
  return d >= SINCE;
};

// ヒット数
const hits = (text, keys) => {
  const t = (text || "").toLowerCase();
  return keys.reduce((acc,k)=> acc + (t.includes(k.toLowerCase()) ? 1 : 0), 0);
};

// タイトル類似（重複排除で使用）
const similar = (a,b) => stringSimilarity.compareTwoStrings(a||"", b||"");

// NewsAPI（日本語＋英語、本文フィールドまで検索）
async function fetchNewsAPI() {
  if (!NEWSAPI_KEY) return [];

  const from = SINCE.toISOString().slice(0,10);
  const common = { sortBy: "publishedAt", pageSize: "50", from, searchIn: "title,description,content" };

  const queries = [
    { q: "(高齢者 OR 介護 OR 老人 OR 在宅医療 OR 地域包括 OR 見守り OR 転倒 OR 認知症) AND (AI OR 人工知能 OR 生成AI OR デジタルヘルス OR 遠隔診療 OR データ分析 OR DX)", language: "ja" },
    { q: "(elderly OR seniors OR geriatric OR \"nursing home\" OR \"long-term care\") AND (AI OR \"artificial intelligence\" OR \"digital health\" OR telemedicine OR \"fall detection\")", language: "en" }
  ];

  async function callNewsAPI(params) {
    const url = new URL("https://newsapi.org/v2/everything");
    Object.entries({ ...common, ...params }).forEach(([k,v]) => url.searchParams.set(k, v));
    const r = await fetch(url.toString(), { headers: { "X-Api-Key": NEWSAPI_KEY }});
    const j = await r.json();
    if (!r.ok) {
      console.warn("NewsAPI error:", j);
      return [];
    }
    return (j.articles || []).map(a => ({
      title: a.title,
      link: a.url,
      iso: a.publishedAt,
      source: a.source?.name || "NewsAPI",
      snippet: a.description || "",
    }));
  }

  const results = [];
  for (const q of queries) {
    results.push(...await callNewsAPI(q));
  }
  return results;
}


// GoogleニュースRSS（検索）で候補補完
// GoogleニュースRSS（国内JP / 海外EN）
// GoogleニュースRSS（国内JP / 海外EN with allowlist site:）
async function fetchGoogleNewsRSS() {
  const results = [];

  // 日本語（国内向け）そのまま
  const qJP = '("高齢者" OR "介護" OR "在宅医療" OR "認知症") (AI OR "人工知能" OR "生成AI" OR "デジタルヘルス" OR "遠隔診療" OR "DX" OR "データ分析")';
  const urlJP = `https://news.google.com/rss/search?q=${encodeURIComponent(qJP)}&hl=ja&gl=JP&ceid=JP:ja`;

  // 英語（海外向け）: allowlist を site: で束ねる
  const baseEN = '(elderly OR seniors OR geriatric OR "nursing home" OR "long-term care" OR "older adults" OR dementia) (AI OR "artificial intelligence" OR "digital health" OR telemedicine OR "fall detection" OR "remote monitoring")';
  const siteQ  = OVERSEAS_ALLOW.map(d => `site:${d}`).join(" OR ");
  const qEN    = `${baseEN} (${siteQ})`;
  const urlEN  = `https://news.google.com/rss/search?q=${encodeURIComponent(qEN)}&hl=en&gl=US&ceid=US:en`;

  const pairs = [
    { url: urlJP, region: "domestic" },
    { url: urlEN, region: "overseas" }
  ];

  for (const { url, region } of pairs) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of (feed.items ?? [])) {
        const raw = it.link;
        const resolved = fromGoogleNewsLink(raw);
        results.push({
          title: it.title,
          link: normalizeUrl(resolved),
          iso: it.isoDate || it.pubDate,
          source: (feed?.title || new URL(url).hostname).replace(/^Google News - /i, "").trim(),
          snippet: it.contentSnippet || it.summary || "",
          region
        });
      }
    } catch (e) {
      console.warn("GNews RSS error:", url, e?.message);
    }
  }
  return results;
}




// RSS取得
async function fetchRSS() {
  const all = [];
  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of (feed.items ?? [])) {
        all.push({
          title: it.title,
          link: it.link,
          iso: it.isoDate || it.pubDate,
          source: feed?.title || new URL(url).hostname,
          snippet: it.contentSnippet || it.summary || "",
        });
      }
    } catch (e) {
      console.warn("RSS error:", url, e?.message);
    }
  }
  return all;
}

// 候補収集→フィルタ→スコア→抽出（国内5／海外3）
// 候補収集→フィルタ→スコア→抽出（国内5／海外3） with フォールバック
// 候補収集→フィルタ→スコア→抽出（国内5／海外3保証）
// 候補収集→質フィルタ→スコア→抽出（海外3件を保証しつつ高品質優先）
async function collectPicks() {
  // 集合（NewsAPIはキー無効なら空が返る実装にしてある想定）
  let pool = [
    ...(await fetchNewsAPI()),
    ...(await fetchGoogleNewsRSS()),
    ...(await fetchRSS())
  ]
    .filter(a => inLast7Days(a.iso))
    .map(a => ({ ...a, link: normalizeUrl(a.link) }))
    .filter(a => !!a.title && !!a.link);

  // 低品質ドメインを除外
  pool = pool.filter(a => !domainIn(AVOID_DOMAINS, a.link));

  // テキスト条件（ANDがゼロならORへ緩める）
  const txtOf = (a) => `${a.title} ${a.snippet || ""}`.toLowerCase();
  const elderHit = (t) => ELDER_KEYS.some(k => t.includes(k.toLowerCase()));
  const aiitHit  = (t) => AIIT_KEYS.some(k => t.includes(k.toLowerCase()));
  let filtered = pool.filter(a => { const t = txtOf(a); return elderHit(t) && aiitHit(t); });
  if (filtered.length === 0) filtered = pool.filter(a => { const t = txtOf(a); return elderHit(t) || aiitHit(t); });

  // 重複排除（URL + 類似タイトル）
  const dedup = [];
  const seen = new Set();
  for (const c of filtered) {
    const key = c.link;
    if (seen.has(key)) continue;
    const dup = dedup.find(d => similar(d.title, c.title) > 0.85);
    if (dup) continue;
    seen.add(key);
    dedup.push(c);
  }

  // 質重みを入れたスコア：関連度 + 新しさ + 信頼度
  const scored = dedup.map(a => {
    const rel = hits(`${a.title} ${a.snippet}`, ELDER_KEYS) + hits(`${a.title} ${a.snippet}`, AIIT_KEYS);
    const ageH = (now() - new Date(a.iso)) / 36e5;
    const fresh = Math.max(0, 168 - ageH) / 168;
    const trust = trustOf(a.link) / 5; // 0〜1
    return { ...a, _score: rel * 3.1 + fresh * 0.0 + trust * 0.2 }; // 信頼に厚めの重み
  }).sort((x,y)=> y._score - x._score);

  // 地域バケット（regionがあれば優先、なければTLD）
  const overseasPool = scored.filter(a => (a.region === "overseas") || (a.region == null && !isDomesticByTLD(a.link)));
  const domesticPool = scored.filter(a => (a.region === "domestic") || (a.region == null &&  isDomesticByTLD(a.link)));

  // まず理想数
  let overseas = overseasPool
    .filter(a => domainIn(OVERSEAS_ALLOW, a.link) || domainIn(OVERSEAS_SEMIALLOW, a.link))
    .slice(0, 3);
  let domestic = domesticPool.slice(0, 5);

  // 海外が不足 → 準allow → 一般 へ段階的補充
  if (overseas.length < 3) {
    const used = new Set(overseas.map(x=>x.link));
    const add1 = overseasPool.filter(a => !used.has(a.link) && domainIn(OVERSEAS_SEMIALLOW, a.link));
    for (const a of add1) { if (overseas.length<3) overseas.push(a); }
  }
  if (overseas.length < 3) {
    const used = new Set(overseas.map(x=>x.link));
    const add2 = overseasPool.filter(a => !used.has(a.link) && !domainIn(AVOID_DOMAINS, a.link));
    for (const a of add2) { if (overseas.length<3) overseas.push(a); }
  }

  // 国内が不足なら全体から補充
  if (domestic.length < 5) {
    const used = new Set([...overseas.map(x=>x.link), ...domestic.map(x=>x.link)]);
    const rest = scored.filter(x => !used.has(x.link) && isDomesticByTLD(x.link));
    for (const a of rest) { if (domestic.length<5) domestic.push(a); }
  }

  return { domestic, overseas };
}




// OpenAIで要約（見出し20字／要約120-180字／タグ3-5）
// OpenAIで本文ベース要約（見出し20字／要約120-180字／タグ3-5）
async function summarizeBatch(items) {
  if (!items.length) return [];
  const results = [];
  for (const it of items) {
    const articleText = await fetchArticleText(it.link); // ← 本文取得（失敗時は空）
    const context = articleText || `${it.title}\n\n${it.snippet || ""}`; // フォールバック

    const prompt = `
あなたは医療分野におけるAIおよびITの専門記者です。以下のニュース本文を事実ベースで要約してください。
出力はJSONのみで返し、次のキーを含めます：
- jp_title: 20字以内の日本語見出し（煽らない・具体）
- jp_summary: 120〜180字の日本語要約（固有名詞・具体数値は維持、誇張しない）
- tags: 日本語タグ 0〜5個。各タグは1語（空白なし）・12文字以内。検索式や論理演算子（OR/AND/()/"、:、URL、site: 等）を含めない。条件を満たせない場合は [] を返す。
- source: 記事配信元のドメインのみ（例: example.com / www.example.co.jp）。文章・タグ・URLは不可。
- url: 記事URL
- published_jst: 空でよい（後段で補完）
本文（最大8000文字に整形済）:
${context}

URL: ${it.link}
SOURCE: ${it.source}
PUBLISHED(ISO): ${it.iso}
`.trim();

    // Responses API: スキーマ強制は text.format に記述（schema/name/strict は format 直下）
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [{ role: "user", content: prompt }],
      temperature: 0.2,
      text: {
        format: {
          type: "json_schema",
          name: "news_card",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              jp_title:   { type: "string", minLength: 1, maxLength: 40 },
              jp_summary: { type: "string", minLength: 40, maxLength: 240 },
              tags: {
                type: "array",
                minItems: 0,
                maxItems: 5,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: 12,
                  // 空白なし・論理演算子/記号/URL禁止
                  pattern: "^(?!.*\\b(?:OR|AND)\\b)(?!.*[()\"/:]|https?://)\\S+$"
                }
              },
              source: { type: "string", pattern: "^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$" },
              url:    { type: "string", pattern: "^https?://.+" },
              published_jst: { type: "string" }
            },
            // ← ここに published_jst を追加
            required: ["jp_title","jp_summary","tags","source","url","published_jst"]
          }
        }
      }
    });

    let json = {};
    try {
      const txt = resp.output_text ?? resp.output?.[0]?.content?.[0]?.text ?? "{}";
      json = JSON.parse(txt);
    } catch {
      // フォールバック（安全側）
      json = {
        jp_title: (it.title || "").slice(0, 20),
        jp_summary: (articleText || it.snippet || "").slice(0, 170),
        tags: [],
        source: it.source,
        url: it.link,
        published_jst: toJST(it.iso)
      };
    }

    // 最終バリデーション＆自動補正
    json.url = isValidUrl(json.url) ? json.url : it.link;
    json.source = fixSource(json.source, json.url, it.source);
    json.tags = sanitizeTags(json.tags);
    json.jp_title = (json.jp_title || it.title || "").slice(0, 40);
    json.jp_summary = (json.jp_summary || it.snippet || "").slice(0, 240);
    json.published_jst = toJST(it.iso);

    results.push(json);
  }
  return results;
}

// --- 補助関数 ---
function isValidUrl(u) {
  try { new URL(u); return true; } catch { return false; }
}

function domainFromUrl(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}

function looksLikeTags(s) {
  if (!s || typeof s !== "string") return false;
  const ban = /\b(?:OR|AND)\b|[()":]|https?:\/\//i;
  return ban.test(s) || s.includes(" ");
}

function looksLikeSentence(s) {
  return /[。．、，]/.test(s) || /\s{2,}/.test(s) || /^#/.test(s) || s.length > 60;
}

function fixSource(src, url, fallback) {
  const domFromUrl = domainFromUrl(url);
  if (!src || looksLikeTags(src) || looksLikeSentence(src)) {
    return domFromUrl || fallback || "unknown";
  }
  if (/^https?:\/\//i.test(src)) return domainFromUrl(src) || domFromUrl || fallback || "unknown";
  return src.split("/")[0];
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const ban = /(?:\bOR\b|\bAND\b|\(|\)|"|:|https?:\/\/)/i;
  const out = [];
  const seen = new Set();
  for (let t of tags) {
    t = String(t || "").trim();
    if (!t) continue;
    if (ban.test(t)) continue;
    if (/\s/.test(t)) continue;       // 1語制約
    if (t.length > 12) continue;
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out.slice(0, 5);
}










function toJST(iso) {
  const d = new Date(iso);
  const j = new Date(d.getTime() + JST * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${j.getFullYear()}-${pad(j.getMonth()+1)}-${pad(j.getDate())} ${pad(j.getHours())}:${pad(j.getMinutes())}`;
}

// Flex Message（カルーセル）生成
function buildFlex(title, items) {
  const bubbles = items.map(it => ({
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: it.jp_title || it.title, weight: "bold", size: "md", wrap: true },
        { type: "text", text: it.jp_summary || "", size: "sm", wrap: true },
        { type: "text", text: `出典: ${it.source} / ${it.published_jst}`, size: "xs", color: "#888888", wrap: true },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        ...(it.tags ? [{ type: "text", text: `#${(it.tags||[]).join(" #")}`, size: "xs", color: "#666666", wrap: true }] : []),
        { type: "button", style: "link", action: { type: "uri", label: "続きを読む", uri: it.url } }
      ]
    }
  }));

  return {
    type: "flex",
    altText: title,
    contents: { type: "carousel", contents: bubbles }
  };
}

// --- LINE送信テスト用 ---
// 全グループ or 既定宛先 or 単一ID へテスト送信
app.get("/test-message", async (req, res) => {
  try {
    let targets = [];
    const toParam = req.query.to;

    if (toParam === "all-groups") {
      targets = await getAllGroupIds();             // Sheetsにある全グループID
    } else if (toParam) {
      targets = [String(toParam)];                  // 明示指定
    } else {
      const def = await getDefaultTo();             // 既定宛先
      if (def) targets = [def];
    }

    targets = targets.filter(v => typeof v === "string" && v.length > 0);
    if (!targets.length) return res.status(400).json({ ok:false, error:"no valid target" });

    const messages = [
      { type: "text", text: "🧪 テストメッセージ（接続確認）" },
      { type: "text", text: "Sheetsに保存された宛先へ送信 ✅" }
    ];

    for (const to of targets) {
      await lineClient.pushMessage(to, messages);
    }
    res.json({ ok:true, sent: targets.length, targets });
  } catch (e) {
    console.error("TEST SEND ERROR:", e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});



// ---- エンドポイント ----
app.get("/broadcast-weekly", async (req, res) => {
  try {
    // 宛先解決
    let targets = [];
    const toParam = req.query.to;
    if (toParam === "all-groups") {
      targets = await getAllGroupIds();
    } else if (toParam) {
      targets = [String(toParam)];
    } else {
      const def = await getDefaultTo();
      if (def) targets = [def];
    }
    targets = targets.filter(v => typeof v === "string" && v.length > 0);
    if (!targets.length) return res.status(400).json({ ok:false, error:"no valid target" });

    // ニュース収集・要約（あなたの既存処理）
    const { domestic, overseas } = await collectPicks();
    const domSum = await summarizeBatch(domestic);
    const ovrSum = await summarizeBatch(overseas);

    const messages = [
      { type: "text", text: `🗞 直近1週間の「${TOPIC}」` },
      buildFlex("国内トピック 5件", domSum),
      buildFlex("海外トピック 3件", ovrSum)
    ];

    const doSend = String(req.query.send || "1") !== "0";
    if (doSend) {
      for (const to of targets) {
        await lineClient.pushMessage(to, messages);
      }
    }

    res.json({ ok:true, sent: doSend ? targets.length : 0, targets, domestic: domSum.length, overseas: ovrSum.length });
  } catch (e) {
    console.error("ERROR /broadcast-weekly:", e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});




// OpenAI 疎通確認: http://localhost:8080/debug/openai
app.get("/debug/openai", async (_req, res) => {
  try {
    const r = await openai.responses.create({
      // まずは通りやすいモデルに
      model: "gpt-4o-mini",
      input: "返答は「ok」だけ。"
    });
    res.json({ ok: true, output: r.output_text });
  } catch (e) {
    res.status(500).json({
      ok: false,
      status: e?.status,
      error: e?.message,
      detail: e?.response?.data || null
    });
  }
});

// 受信イベントを丸ごとログって groupId/roomId を取得
app.post("/webhook", express.json(), async (req, res) => {
  const events = req.body?.events || [];
  res.send("ok"); // 先に応答
  for (const ev of events) {
    await rememberSource(ev); // ★ Sheets に記録
    //if (ev.type === "message" && ev.message?.type === "text") {
      //try {
      //  await lineClient.replyMessage(ev.replyToken, {
      //    type: "text",
      //    text: `受け取りました: 「${ev.message.text}」`
      //  });
      //} catch (e) {
      //  console.error("reply error:", e?.statusCode, e?.body || e?.message);
    //  }
    //}
  }
});



// LINE Push 単体テスト: http://localhost:8080/debug/line-push?to=Uxxxxxxxx...
app.get("/debug/line-push", async (req, res) => {
  try {
    const { to } = req.query;
    if (!to) return res.status(400).json({ ok: false, error: "query 'to' is required" });
    await lineClient.pushMessage(to, { type: "text", text: "LINE push ok" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.body || String(e) });
  }
});

// 収集状況を可視化：?n=5 で各カテゴリ上位N件のタイトルを返す
app.get("/debug/collect", async (req, res) => {
  try {
    const n = Math.max(1, Math.min(20, parseInt(req.query.n || "5", 10)));
    const { domestic, overseas } = await collectPicks();
    res.json({
      ok: true,
      since_iso: SINCE.toISOString(),
      domestic_count: domestic.length,
      overseas_count: overseas.length,
      domestic_samples: domestic.slice(0, n).map(a => ({ title: a.title, source: a.source, link: a.link })),
      overseas_samples: overseas.slice(0, n).map(a => ({ title: a.title, source: a.source, link: a.link }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/groups", async (_req, res) => {
  const rows = await (await import("./index.js")).readAllRows?.().catch(()=>null); // 省略可
  // readAllRows をエクスポートしなければ、getAllGroupIds と getDefaultTo から組み立ててもOK
  const ids = await getAllGroupIds();
  const def = await getDefaultTo();
  res.json({ ok: true, defaultTo: def, groups: ids });
});

app.get("/groups/test", async (_req, res) => {
  try {
    const to = await getDefaultTo();
    if (!to) return res.status(400).json({ ok: false, error: "no default destination" });
    await lineClient.pushMessage(to, { type: "text", text: "✅ 既定宛先（Sheets）へのテスト送信です" });
    res.json({ ok: true, to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.body || e?.message || String(e) });
  }
});

app.post("/groups/default", express.json(), async (req, res) => {
  const to = req.query.to || req.body?.to;
  if (!to) return res.status(400).json({ ok: false, error: "to is required" });
  await setDefaultRow(to);
  res.json({ ok: true, defaultTo: to });
});

app.get("/debug/sheets", async (_req, res) => {
  try {
    const s = await getSheets(); // 上でauthorize実行済みの関数
    if (!s) return res.status(500).json({ ok:false, error:"auth/init failed. Check server logs." });
    const r = await s.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: `${process.env.SHEETS_SHEET_NAME || "groups"}!A1:D2`,
    });
    res.json({ ok:true, values: r.data.values || [] });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// ── 追記：環境変数と鍵の整形を可視化
app.get("/debug/sheets-env", (_req, res) => {
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "";
  const repaired = rawKey.replace(/\\n/g, "\n");
  const hasBegin = repaired.startsWith("-----BEGIN PRIVATE KEY-----");
  const hasEnd   = repaired.trim().endsWith("-----END PRIVATE KEY-----");
  res.json({
    ok: true,
    SHEETS_SPREADSHEET_ID: process.env.SHEETS_SPREADSHEET_ID || null,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null,
    KEY_present: !!rawKey,
    KEY_has_BEGIN: hasBegin,
    KEY_has_END: hasEnd,
    KEY_starts_with_charCode: repaired.charCodeAt(0) || null, // 45('-')であるべき
    note: "KEY はレスポンスに含めません（安全のため）。BEGIN/END 判定だけ返しています。"
  });
});



app.get("/debug/sheets-auth", async (_req, res) => {
  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
    const raw   = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "";
    // ローカルが“実改行”なら raw のまま、Render の \n の場合は下の行で置換して試す
    const keyA  = raw;                       // 実改行想定
    const keyB  = raw.replace(/\\n/g, "\n"); // \n→改行想定

    const diag = {
      email,
      raw_len: raw.length,
      A_has_BEGIN: keyA.startsWith("-----BEGIN PRIVATE KEY-----"),
      B_has_BEGIN: keyB.startsWith("-----BEGIN PRIVATE KEY-----"),
    };
    if (!email || !raw) {
      return res.status(500).json({ ok:false, step:"env", error:"missing email or key", diag });
    }

    // まず GoogleAuth + keyA で試す
    try {
      const auth = new google.auth.GoogleAuth({
        credentials: { client_email: email, private_key: keyA },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      await auth.getClient();
      return res.json({ ok:true, step:"authorize", method:"GoogleAuth+A(raw)", diag });
    } catch (eA) {
      // ダメなら keyB で
      try {
        const auth = new google.auth.GoogleAuth({
          credentials: { client_email: email, private_key: keyB },
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        await auth.getClient();
        return res.json({ ok:true, step:"authorize", method:"GoogleAuth+B(\\n->LF)", diag });
      } catch (eB) {
        return res.status(500).json({
          ok:false, step:"authorize", errorA: eA?.message || String(eA), errorB: eB?.message || String(eB), diag
        });
      }
    }
  } catch (e) {
    return res.status(500).json({ ok:false, step:"route", error: e?.message || String(e) });
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));