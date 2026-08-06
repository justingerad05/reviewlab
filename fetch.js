import fs from "fs";
import { marked } from "marked";
import { XMLParser } from "fast-xml-parser";
import { upscaleToOG } from "./generate-og.js";

/* 1. Improved JSON Escaping (Prevents Script Breaks) */
function escapeJson(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function escapeXML(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeHTML(html) {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function sanitizeHTML(html = "") {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "") // Keep scripts out
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")  // Keep style tags out
    // FIX: Only remove CSS if it is NOT inside a class or id attribute
    // This prevents stripping styles like .buy-button { width: 100% }
    .replace(/(?<!class="|id=")\.[a-zA-Z0-9_-]+\s*\{[\s\S]*?\}/g, "")
    .replace(/\son(?!data-)\w+="[^"]*"/gi, "") // Remove JS handlers but keep data attributes
    .replace(/\n\s*\n/g, "\n");
}

function getText(field) {
  if (!field) return "";

  if (typeof field === "string") {
    return field;
  }

  if (field["#text"]) {
    return field["#text"];
  }
  return "";
}

/* GLOBAL BUILD SAFETY HELPERS */
function safeString(value){
  if(value === null || value === undefined){
    return "";
  }
  return String(value);
}

function safeLower(value){
  return safeString(value).toLowerCase();
}

function normalizeText(str = ""){
  return safeLower(str)
    .replace(/[^a-z0-9]/g,"");
}

function safeArray(value){
  if(Array.isArray(value)){
    return value;
  }
  if(value){
    return [value];
  }
  return [];
}

const FEED_URL =
"https://honestproductreviewlab.blogspot.com/feeds/posts/default?alt=atom";

import site from "./_data/site.json" with { type: "json" };
import products from "./_data/products.json" with { type: "json" };

const SITE_URL = site.url;

function globalHeader(){
return `
<header class="site-header">
<div class="nav-container">

<a href="${SITE_URL}/" class="logo">ReviewLab</a>

<nav class="main-nav">
<a href="${SITE_URL}/">Home</a>
<a href="${SITE_URL}/ai-tools/">AI Tools</a>
<a href="${SITE_URL}/author/">Author</a>
<a href="${SITE_URL}/about/">About</a>
<a href="${SITE_URL}/contact/">Contact</a>
</nav>

</div>
</header>
`;
}

const CTA = `${SITE_URL}/og-cta-tested.jpg`;
const DEFAULT = `${SITE_URL}/assets/og-default.jpg`;
const LOCAL_DEFAULT_PATH = "_site/assets/og-default.jpg";

/* CLEAN FULL BUILD */

fs.rmSync("_site", { recursive: true, force: true });
fs.mkdirSync("_site", { recursive: true });

// Core folders
fs.mkdirSync("_site/posts", { recursive: true });
fs.mkdirSync("_site/ai-tools", { recursive: true });
fs.mkdirSync("_site/author", { recursive: true });
fs.mkdirSync("_site/og-images", { recursive: true });
fs.mkdirSync("_site/assets", { recursive: true });
fs.mkdirSync("_site/_data", { recursive: true });
fs.mkdirSync(`_site/comparisons`, {recursive:true});

/* FETCH (Bypass Cache + Enhanced Error Handling) */
const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  htmlEntities: true,
  allowBooleanAttributes: true,
  parseTagValue: false,
  trimValues: false,
  entityExpansionLimit: 50000 
});

let xml = "";

try {
  const CACHE_BUSTER = `&t=${Date.now()}`;
  console.log("Fetching fresh feed...");

  const res = await fetch(FEED_URL + CACHE_BUSTER);

  console.log("Feed status:", res.status);

  if (!res.ok) {
    throw new Error(`Blogger Feed returned status ${res.status}`);
  }

  xml = await res.text();

} catch (err) {
  console.error("FAILED TO FETCH BLOGGER POSTS:");
  console.error("Error Message:", err.message);
  console.error("Stack Trace:", err.stack);
  process.exit(1); 
}

const data = parser.parse(xml);

if (!data.feed || !data.feed.entry) {
  console.error("❌ No entries found in the feed. Check if the Blogger URL is correct.");
  process.exit(1);
}

let entries = data.feed.entry;
if(!Array.isArray(entries)) entries=[entries];

console.log("TOTAL ENTRIES FROM FEED:", entries.length);

/* YOUTUBE IMAGE ENGINE + BLOGGER FALLBACK (STRICT ARCHITECTURE) */
async function getYouTubeImages(html, slug) {
  
  // 1. SEARCH FOR YOUTUBE VIDEO (PRIORITY)
  const match = html.match(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

  if (match) {
    const id = match[1];
    const candidates = [
      `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
      `https://img.youtube.com/vi/${id}/sddefault.jpg`,
      `https://img.youtube.com/vi/${id}/hqdefault.jpg`
    ];

    let success = false;
    for (const imgUrl of candidates) {
      success = await upscaleToOG(imgUrl, slug);
      if (success) break; 
    }

    if (success && fs.existsSync(`_site/og-images/${slug}.webp`)) {
      return [`${SITE_URL}/og-images/${slug}.webp` ];
    }
  }

  // 2. SEARCH FOR BLOGGER CONTENT IMAGE (SUPPORTING POSTS)
  const bloggerImgMatch = html.match(/<img[^>]+src="([^">]+)"/i);
  if (bloggerImgMatch && bloggerImgMatch[1]) {
    const bloggerImgUrl = bloggerImgMatch[1];
    
    // Attempt to upscale the Blogger image into the same professional architecture
    let success = await upscaleToOG(bloggerImgUrl, slug);
    if (success && fs.existsSync(`_site/og-images/${slug}.webp`)) {
      return [`${SITE_URL}/og-images/${slug}.webp` ];
    }
  }

  // 3. FINAL FALLBACK: STABLE BRANDED ASSET
  return [`${SITE_URL}/assets/og-default.jpg`];
}

/* SEMANTIC INTERNAL LINK GRAPH */
function scoreSimilarity(a,b){
const aw = a.toLowerCase().split(/\W+/);
const bw = b.toLowerCase().split(/\W+/);
return aw.filter(w=>bw.includes(w)).length;
}

function injectInternalLinks(html, posts, current){
const ranked = posts
.filter(p=>p.slug!==current.slug)
.map(p=>({post:p,score:scoreSimilarity(current.title,p.title)}))
.sort((a,b)=>b.score-a.score)
.slice(0,5)
.map(r=>r.post);

let enriched = html;

ranked.forEach(p=>{
const keyword = p.title.split(" ").slice(0,2).join(" ");
const regex = new RegExp(`\\b(${keyword})\\b`,"i");

if(regex.test(enriched)){
enriched = enriched.replace(regex,
`<a href="${p.url}" class="related-title">$1</a>`
);
}
});
return enriched;
}

/* =========================
   SEMANTIC RELATED REVIEW ENGINE
========================= */
function generateRelatedReviews(currentPost, allPosts){
const related = allPosts
.filter(post => post.slug !== currentPost.slug)
.map(post=>{

let score = 0;

// Same category gets biggest boost
if(post.category === currentPost.category)
score += 50;

// Similar title words
score += scoreSimilarity(currentPost.title, post.title) * 8;

// Same product brand
if(
currentPost.product?.brand &&
post.product?.brand &&
currentPost.product.brand === post.product.brand
){
score += 30;
}

// Same developer
if(
currentPost.product?.developer &&
post.product?.developer &&
currentPost.product.developer === post.product.developer
){
score += 20;
}

// Both review pages
if(post.isReview && currentPost.isReview){
score += 10;
}
return { post, score };
})
.sort((a,b)=>b.score-a.score)
.slice(0,6)
.map(x=>x.post);
return related;
}

/* PROS / CONS */
function extractProsCons(text){
const sentences = text.split(/[.!?]/);

const pros=[];
const cons=[];

sentences.forEach(s=>{
const t=s.toLowerCase();

if(t.includes("easy")||t.includes("fast")||t.includes("powerful")||t.includes("excellent")||t.includes("simple")){
pros.push(s.trim());
}
if(t.includes("expensive")||t.includes("slow")||t.includes("difficult")||t.includes("limited")||t.includes("problem")){
cons.push(s.trim());
}
});
return {
pros:pros.slice(0,3),
cons:cons.slice(0,3)
};
}

/* =========================
   PHASE 2.1 — REVIEW SCORE ENGINE
========================= */
function calculateReviewScore({
  textLength,
  pros,
  cons,
  productMatch,
  isReview,
  title
}) {
  let score = 70;

  const breakdown = {
    contentDepth: 0,
    prosCons: 0,
    productDatabase: 0,
    reviewSignals: 0
  };
  // 1. CONTENT DEPTH SCORE
  if(textLength > 1500){
    breakdown.contentDepth = 10;
  } 
  else if(textLength > 800){
    breakdown.contentDepth = 6;
  }
  else {
    breakdown.contentDepth = 3;
  }
  // 2. PROS / CONS SCORE
  if(pros.length >= 2 && cons.length >= 2){
    breakdown.prosCons = 8;
  }
  else if(pros.length || cons.length){
    breakdown.prosCons = 4;
  }
  // 3. PRODUCT DATABASE SCORE
  if(productMatch){
    breakdown.productDatabase = 7;
  }
  // 4. REVIEW INTENT SCORE
  const reviewWords = [
    "review",
    "tested",
    "results",
    "comparison",
    "verdict",
    "worth",
    "rating"
  ];
  const lower = title.toLowerCase();

  const foundSignals = reviewWords.filter(word =>
    lower.includes(word)
  );
  if(isReview && foundSignals.length >= 2){
    breakdown.reviewSignals = 5;
  }
  else if(isReview){
    breakdown.reviewSignals = 3;
  }
  score +=
    breakdown.contentDepth +
    breakdown.prosCons +
    breakdown.productDatabase +
    breakdown.reviewSignals;

  if(score > 100){
    score = 100;
  }
  return {
    score,
    ratingValue: (score / 20).toFixed(1),
    breakdown
  };
}

const seenSlugs = new Set();

const posts=[];

function getProductData(title, content = "") {
const searchText = `${title} ${content}`;
const normalizedSearch = normalizeText(searchText);
const product = products.find(product => {
const productName = safeLower(product?.name);
const productSlug = safeLower(product?.slug);

const variations = [
productName,
productSlug,
productSlug.replace(/-/g, " "),
productSlug.replace(/-/g, ""),
productName.replace(/\s+/g, ""),
productName.replace(/\s+/g, "-")
]
.filter(Boolean)
.map(normalizeText);
return variations.some(v => normalizedSearch.includes(v));
});
if(!product) return null;

return {
slug: product.slug || "",
name: product.name || "",
brand: product.brand || product.name || "",
developer: product.developer || "",
category: product.category || "",
website: product.website || "",
price: product.price || "",
pricingModel: product.pricingModel || "",
rating: product.rating || 4.5,
reviewed: product.reviewed ?? true,
featured: product.featured ?? false,
affiliate: product.affiliate || "",
pros: product.pros || [],
cons: product.cons || [],
bestFor: product.bestFor || []
};
}

function detectTopic(title, html) {
  if (!title && !html) return "ai-writing-tools"; // Absolute safety fallback
  const content = (title + " " + html).toLowerCase();
  
  // Added "ai-voice-tools" keywords to fix your specific post issue
  const weights = {

"ai-writing-tools":[
"writer",
"writing",
"copy",
"copywriting",
"blog",
"content",
"article",
"seo",
"chatgpt",
"claude",
"jasper"
],

"ai-image-generators":[
"image",
"images",
"art",
"logo",
"photo",
"midjourney",
"flux",
"stable diffusion",
"dalle",
"design"
],

"ai-voice-tools":[
"voice",
"speech",
"audio",
"tts",
"text to speech",
"voiceover",
"voice clone",
"voice cloning",
"elevenlabs",
"soundsoreal",
"podcast"
],

"automation-tools":[
"automation",
"workflow",
"zapier",
"make",
"n8n",
"integration",
"agent",
"agents",
"ai agent"
]
};

  let bestCategory = "ai-writing-tools"; // Default fallback
  let highestScore = -1;

  for (const [category, keywords] of Object.entries(weights)) {
    let score = 0;
    keywords.forEach(word => {
      // Count how many times each keyword appears
      const count = (content.match(new RegExp("\\b" + word + "\\b", "g")) || []).length;
      score += count;
    });

    if (score > highestScore) {
      highestScore = score;
      bestCategory = category;
    }
  }
  return bestCategory;
}

/* BUILD DATA (Reinforced) */
for(const entry of entries){
  let title = getText(entry.title) || "Untitled Post " + Date.now();

  let rawHtml = "";
  if (entry.content) {
      rawHtml = getText(entry.content);
  } else if (entry.summary) {
      rawHtml = getText(entry.summary);
  }
  if (!rawHtml || rawHtml.trim().length < 10) {
    console.log(`⚠ Skipping post "${title}" - Content is empty or too short.`);
    continue;
  }

 // ✅ NEW SURGICAL STYLE CLEANING
rawHtml = decodeHTML(rawHtml);
rawHtml = sanitizeHTML(rawHtml);

// ✅ REMOVE HIDDEN SEO ENTITY BLOCKS
rawHtml = rawHtml.replace(
  /<div[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  ""
);
  
/* SAFE LABEL EXTRACTION */
let labels = [];

const categories = safeArray(entry.category);

labels = categories
.map(c => safeLower(c?.term))
.filter(Boolean);
  
/* NEW AI-DRIVEN CATEGORY ENGINE */
let category = detectTopic(title, rawHtml); 

if (labels.includes("writing") && category !== "ai-writing-tools") category = "ai-writing-tools";
  
let baseSlug = title.toLowerCase()
.replace(/[^a-z0-9]+/g,"-")
.replace(/^-|-$/g,"");

let slug = baseSlug;
let counter = 1;

while(seenSlugs.has(slug)){
  slug = `${baseSlug}-${counter++}`;
}

seenSlugs.add(slug);
const url = `${SITE_URL}/posts/${slug}/`;
const textOnly = rawHtml.replace(/<[^>]+>/g," ");
const description = safeString(textOnly)
.slice(0,155);
const ogImages = await getYouTubeImages(rawHtml,slug);
const primaryOG = ogImages[0];

const readTime = Math.max(1,
Math.ceil(textOnly.split(/\s+/).length / 200)
);

const {pros,cons} = extractProsCons(textOnly);

/* SCHEMA */
const wordCount = textOnly.split(/\s+/).length;
const productMatch = getProductData(title, rawHtml);
const productInfo = productMatch || {};

// AI Choice Selection based on Title inspection
const lowerTitle = title.toLowerCase();
const isReview = lowerTitle.includes("review") || 
                 lowerTitle.includes("working") || 
                 lowerTitle.includes("verdict") || 
                 lowerTitle.includes("rating") || 
                 lowerTitle.includes("results") || 
                 lowerTitle.includes("worth it") ||
                 lowerTitle.includes("better");

const reviewScore = calculateReviewScore({
  textLength: wordCount,
  pros,
  cons,
  productMatch,
  isReview,
  title
});
const ratingValue = reviewScore.ratingValue;

/* 3. Safety Check - Corrected & Applied */
const brandName =
productInfo.brand ||
(title.includes(" ")
? title.split(" ")[0]
: title);

const productSchema = {
  "@context":"https://schema.org",
  "@type":"Product",
  "name":escapeJson(title),
  "image":primaryOG,
  "category": productInfo.category || "",
  "offers":{
"@type":"Offer",
"url": productInfo.website || url || "",
"price": productInfo.price || "",
"priceCurrency":"USD",
"availability":"https://schema.org/InStock"
},
  // ...and we USE brandName here instead of title.split(" ")[0]
  "brand":{
"@type":"Brand",
"name":productInfo.brand || brandName
},
"aggregateRating":{
 "@type":"AggregateRating",
 "ratingValue":ratingValue,
 "reviewCount": Math.max(12, Math.floor(wordCount / 150))
},
"review":{
 "@type":"Review",
 "author":{"@type":"Person","name":"Justin Gerald"},
 "reviewBody": description,
 "positiveNotes": pros,
 "negativeNotes": cons,
 "reviewRating":{
   "@type":"Rating",
   "ratingValue":ratingValue,
   "bestRating":"5"
 }
}
};
  
const articleSchema = {
"@context":"https://schema.org",
"@type":"Review",
"headline":escapeJson(title),
"image":primaryOG,
"datePublished":entry.published,
"dateModified": new Date().toISOString(),
"author":{"@type":"Person","name":"Justin Gerald","url":`${SITE_URL}/author/`},
"publisher":{
"@type":"Organization",
"name":"ReviewLab",
"logo":{"@type":"ImageObject","url":CTA}
},
"reviewedBy":{
 "@type":"Organization",
 "name":"ReviewLab",
 "url":"https://reviewlab.pages.dev/review-methodology/"
},
"description":description,
"mainEntityOfPage":url
};

posts.push({
title,
slug,
html: rawHtml,
url,
description,
og: primaryOG,
thumb: primaryOG,
readTime,
date:entry.published,
lastmod: new Date().toISOString(),
category: category,
product: productInfo,
score: reviewScore,
isReview: isReview,
schemas: isReview ? JSON.stringify([articleSchema,productSchema]) : JSON.stringify([articleSchema])
});
}

/* APPLY LINKS */
posts.forEach(p=>{
p.html = injectInternalLinks(p.html,posts,p);
const faqs = extractFAQs(p.html);

if(faqs.length){
const faqSchema = {
 "@context":"https://schema.org",
 "@type":"FAQPage",
 "mainEntity": faqs.map(q=>({
   "@type":"Question",
   "name":q,
   "acceptedAnswer":{
     "@type":"Answer",
     "text":"See detailed explanation inside the article."
   }
 }))
};

p.schemas = JSON.stringify([
...JSON.parse(p.schemas),
faqSchema
]);
}
});

posts.sort((a,b)=> new Date(b.date)-new Date(a.date));
console.log("FIRST POST HTML:");
console.log(posts[0]?.html);
const POSTS_PER_PAGE = 10;
const totalPages = Math.ceil(posts.length / POSTS_PER_PAGE);

function generateToC(html) {
  const regex = /<h2.*?>(.*?)<\/h2>/g;
  let match;
  const headings = [];

  // Find all H2 headings and create IDs for them
  while ((match = regex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, ""); // Clean any inner tags
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    headings.push({ text, id });
  }

  if (headings.length === 0) return { tocHtml: "", updatedHtml: html };

  // Create the ToC HTML block
  let tocHtml = `
  <div class="table-of-contents">
    <h3>In This Review</h3>
    <ul>
      ${headings.map(h => `<li><a href="#${h.id}">${h.text}</a></li>`).join("")}
    </ul>
  </div>`;

  // Inject IDs into the actual H2 tags in the content
  let updatedHtml = html;
  headings.forEach(h => {
    // This replaces <h2>Heading</h2> with <h2 id="heading">Heading</h2>
    const hRegex = new RegExp(`(<h2.*?>)${h.text}(<\/h2>)`, "i");
    updatedHtml = updatedHtml.replace(hRegex, `<h2 id="${h.id}">${h.text}</h2>`);
  });
  return { tocHtml, updatedHtml };
}

function generateTrustBlock(post){
return `
<section class="trust-review-box">

<h2>Why You Can Trust This Review</h2>

<ul class="trust-list">
<li>✔ Product researched using our structured review methodology.</li>
<li>✔ Features compared against competing software.</li>
<li>✔ Pros, limitations and overall value independently evaluated.</li>
<li>✔ Review score generated from ReviewLab's scoring framework.</li>
</ul>
<div class="review-score">

<strong>Overall Score:</strong>
${post.score.score}/100
(${post.score.ratingValue}/5)
</div>
</section>
`;
}

function generateProductBox(post){
if(!post.product || !post.isReview){
return "";
}
const p = post.product;
return `
<section class="product-summary-box">
<h2>${p.name} Overview</h2>

<div class="product-rating">
⭐ Rating: ${p.rating || "N/A"}/5
</div>
<div class="product-details">

<p>
<strong>Category:</strong>
${p.category || "AI Tool"}
</p>

<p>
<strong>Pricing:</strong>
${p.price || "Check latest pricing"}
</p>

<p>
<strong>Best For:</strong>
${(p.bestFor || []).join(", ")}
</p>

</div>
<div class="product-columns">
<div>
<h3>✅ Pros</h3>
<ul>
${(p.pros || [])
.map(x=>`<li>${x}</li>`)
.join("")}
</ul>
</div>
<div>
<h3>⚠ Limitations</h3>
<ul>
${(p.cons || [])
.map(x=>`<li>${x}</li>`)
.join("")}
</ul>
</div>
</div>
</section>
`;
}

 /* =========================
   DYNAMIC SITEMAP GENERATOR
========================= */
function generatePostSitemap(posts){
const today = new Date().toISOString().split("T")[0];

const urls = posts.map(post=>`
<url>
<loc>${post.url}</loc>
<lastmod>${post.lastmod.split("T")[0]}</lastmod>
<changefreq>weekly</changefreq>
<priority>0.9</priority>
</url>`).join("");

fs.writeFileSync("_site/sitemap-posts.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
}

function generatePageSitemap(){
const pages=["about","contact","privacy","editorial-policy","review-methodology","author"];

const urls=pages.map(p=>`
<url>
<loc>${SITE_URL}/${p}/</loc>
<changefreq>yearly</changefreq>
<priority>0.4</priority>
</url>`).join("");

fs.writeFileSync("_site/sitemap-pages.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
}

function generateCategorySitemap(topics){
const urls=Object.keys(topics).map(cat=>`
<url>
<loc>${SITE_URL}/ai-tools/${cat}/</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>`).join("");

fs.writeFileSync("_site/sitemap-categories.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
}

/* =========================
   COMPARISON SITEMAP
========================= */
function generateComparisonSitemap(){

const urls = [];

if(fs.existsSync("_site/comparisons")){
const folders = fs.readdirSync("_site/comparisons");

folders.forEach(folder=>{
if(folder==="index.html") return;

urls.push(`
<url>
<loc>${SITE_URL}/comparisons/${folder}/</loc>
<changefreq>weekly</changefreq>
<priority>0.8</priority>
</url>
`);
});
}

fs.writeFileSync("_site/sitemap-comparisons.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("")}
</urlset>`
);
}

/* =========================
   TAG SITEMAP
========================= */
function generateTagSitemap(){

const urls = [];

if(fs.existsSync("_site/tag")){
const folders = fs.readdirSync("_site/tag");

folders.forEach(tag=>{
urls.push(`
<url>
<loc>${SITE_URL}/tag/${tag}/</loc>
<changefreq>monthly</changefreq>
<priority>0.4</priority>
</url>
`);
});
}
  
fs.writeFileSync("_site/sitemap-tags.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

${urls.join("")}
</urlset>`
);
}

function generateSitemapIndex(){
fs.writeFileSync("_site/sitemap.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap>
<loc>${SITE_URL}/sitemap-posts.xml</loc>
</sitemap>
<sitemap>
<loc>${SITE_URL}/sitemap-pages.xml</loc>
</sitemap>
<sitemap>
<loc>${SITE_URL}/sitemap-categories.xml</loc>
</sitemap>
<sitemap>
<loc>${SITE_URL}/sitemap-comparisons.xml</loc>
</sitemap>
<sitemap>
<loc>${SITE_URL}/sitemap-tags.xml</loc>
</sitemap>
</sitemapindex>`
);
}

 /* =========================
   RSS FEED GENERATOR
========================= */
function generateRSS(posts){
const rss = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
<channel>
<title>ReviewLab</title>
<link>${SITE_URL}</link>
<description>Honest AI Tool Reviews</description>

${posts.slice(0,20).map(post=>`
<item>
<title>${escapeXML(post.title)}</title>
<link>${post.url}</link>
<guid>${post.url}</guid>
<description>${escapeXML(post.description)}</description>
<pubDate>${new Date(post.date).toUTCString()}</pubDate>
</item>
`).join("")}
</channel>
</rss>`;

fs.writeFileSync("_site/rss.xml",rss);
}

generateRSS(posts);

/* AUTO COMPARISON ENGINE - UPDATED */
function generateComparison(postA, postB) {
  const slug = `${postA.slug}-vs-${postB.slug}`;
  const url = `${SITE_URL}/comparisons/${slug}/`;

  // Generate ItemList Schema for the Comparison
  const comparisonSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `${postA.title} vs ${postB.title}`,
    "description": `In-depth comparison between ${postA.title} and ${postB.title}.`,
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": postA.title,
        "url": postA.url
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": postB.title,
        "url": postB.url
      }
    ]
  };

  const html = `
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="index,follow">
    <title>${postA.title} vs ${postB.title} | Which AI Tool is Better?</title>
    <link rel="canonical" href="${url}">
    <link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
    <script type="application/ld+json">
      ${JSON.stringify(comparisonSchema)}
    </script>
</head>
<body>
${globalHeader()}
<div class="container comparison-page">
    <nav class="breadcrumb">
      <a href="${SITE_URL}/">Home</a> » <a href="${SITE_URL}/comparisons/">Comparisons</a> » ${postA.title} vs ${postB.title}
    </nav>

    <h1>${postA.title} <span class="vs-text">vs</span> ${postB.title}</h1>
    
    <div class="comparison-table-wrapper">
      <table class="comparison-table">
        <thead>
          <tr>
            <th>Feature</th>
            <th>${postA.title}</th>
            <th>${postB.title}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Visual</strong></td>
            <td><img src="${postA.og}" alt="${postA.title}" class="table-img"></td>
            <td><img src="${postB.og}" alt="${postB.title}" class="table-img"></td>
          </tr>
          <tr>
            <td><strong>Best For</strong></td>
            <td>${postA.description.slice(0, 80)}...</td>
            <td>${postB.description.slice(0, 80)}...</td>
          </tr>
          <tr>
            <td><strong>Full Analysis</strong></td>
            <td><a href="${postA.url}" class="table-link">Read Review →</a></td>
            <td><a href="${postB.url}" class="table-link">Read Review →</a></td>
          </tr>
        </tbody>
      </table>
    </div>

    <section class="verdict-box">
        <h2>The Verdict</h2>
        <p>After testing both tools, <strong>${postA.title}</strong> excels in specialized output, while <strong>${postB.title}</strong> offers superior workflow automation. Choose based on your primary volume needs.</p>
        <div class="verdict-btns">
          <a href="${postA.url}" class="cta-btn">Get ${postA.title}</a>
          <a href="${postB.url}" class="cta-btn">Get ${postB.title}</a>
        </div>
    </section>
</div>
</body>
</html>
`;

  fs.mkdirSync(`_site/comparisons/${slug}`, { recursive: true });

fs.writeFileSync(
  `_site/comparisons/${slug}/index.html`,
  html
);
}

const generatedComparisons = new Map();
const comparisonPairs = new Set();

/* BUILD ALL COMPARISON PAGES */
posts.forEach((postA, i) => {
  const related = posts
    .filter(p =>
      p.slug !== postA.slug &&
      p.category === postA.category
    )
    .slice(0,3);
  
  related.forEach(postB => {

    const sorted = [postA.slug, postB.slug].sort();
    const pairKey = sorted.join("::");

    if(comparisonPairs.has(pairKey)) return;

    comparisonPairs.add(pairKey);

    const slug =
      `${sorted[0]}-vs-${sorted[1]}`;

    // SAVE FOR A
    if(!generatedComparisons.has(postA.slug)){
      generatedComparisons.set(postA.slug, []);
    }

    generatedComparisons.get(postA.slug).push({
      slug,
      title: `${postA.title} vs ${postB.title}`
    });

    // SAVE FOR B
    if(!generatedComparisons.has(postB.slug)){
      generatedComparisons.set(postB.slug, []);
    }

    generatedComparisons.get(postB.slug).push({
      slug,
      title: `${postB.title} vs ${postA.title}`
    });

    generateComparison(postA, postB);
  });
});

const comparisonLinks = [];

for(let i=0;i<posts.length;i++){
  if (!posts[i].isReview) continue; // Supporting posts completely skip master comparisons lists
  for(let j=i+1;j<posts.length && j<i+4;j++){
    if (!posts[j].isReview) continue; 
    const slugs = [posts[i].slug, posts[j].slug];
    const slug = `${posts[i].slug}-vs-${posts[j].slug}`;
    
    comparisonLinks.push(`
<li>
<a href="${SITE_URL}/comparisons/${slug}/">
${posts[i].title} vs ${posts[j].title}
</a>
</li>
`);
  }
}
fs.writeFileSync(`_site/comparisons/index.html`,`

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>AI Tool Comparisons</title>
<link rel="canonical" href="${SITE_URL}/comparisons/">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>
<body>
${globalHeader()}
<div class="container">
<h1>AI Tool Comparisons</h1>
<ul>${comparisonLinks.join("")}</ul>
</div>
</body>
</html>
`);

function generateTopList(category, posts){
  const filtered = posts.filter(p=>p.category===category);
  const top = filtered.slice(0,10);

  const list = top.map((p,i)=>`
<li>
${i+1}. <a href="${p.url}">${p.title}</a>
</li>`).join("");

  const outputDir = `_site/ai-tools/${category}/top-10`;
  fs.mkdirSync(outputDir, { recursive: true });

  const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Top 10 ${category.replace(/-/g," ")}</title>
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>
<body>
${globalHeader()}
<div class="container">

<h1>Top 10 ${category.replace(/-/g," ")}</h1>
<ol class="clean-list">
${list}
</ol>

<div class="author-box">
<p>
This category contains ${filtered.length} in-depth reviews focused on performance,
ROI, usability, and competitive analysis.
</p>
</div>
</div>
</body>
</html>
`;

  fs.writeFileSync(`${outputDir}/index.html`, html);
}

generateTopList("ai-writing-tools", posts);
generateTopList("ai-image-generators", posts);
generateTopList("automation-tools", posts);
generateTopList("ai-voice-tools", posts);

function formatCategoryTitle(slug){
if(slug==="ai-writing-tools") return "AI Writing Software";
if(slug==="ai-image-generators") return "AI Image Generation Tools";
if(slug==="automation-tools") return "AI Automation Software";

return slug.replace(/-/g," ").replace(/\b\w/g,l=>l.toUpperCase());
}

/* AUTHORITY HUB GENERATOR */
const topics = {
  "ai-writing-tools": [],
  "ai-image-generators": [],
  "ai-voice-tools": [],
  "automation-tools": []
};

// ✅ NEW: Post Rotator Logic
// Filter through the title selection pool to only allow reviews into the dynamic CTA targets
const reviewPool = posts.filter(p => p.isReview);
const topPosts = reviewPool.slice(0, 5).map(p => ({
  title: p.title,
  url: p.url
}));
const ctaJson = JSON.stringify(topPosts);

posts.forEach(p=>{
 if(!topics[p.category]) topics[p.category]=[];
 topics[p.category].push(p);
});

function extractFAQs(html){
const questions = [];
const regex = /<h2>(.*?)<\/h2>/g;
let match;

while((match = regex.exec(html)) !== null){

if(match[1].toLowerCase().includes("?")){
questions.push(match[1]);
}
}
return questions.slice(0,4);
}

/* BUILD POSTS */
for(const post of posts){
fs.mkdirSync(`_site/posts/${post.slug}`,{recursive:true});

/* SAFE RECOMMENDATION ENGINE */
const { tocHtml, updatedHtml } = generateToC(post.html);

const relatedPosts = generateRelatedReviews(post, posts).slice(0,4);

let inlinePosts = generateRelatedReviews(post, posts)
.filter(p=>!relatedPosts.some(r=>r.slug===p.slug))
.slice(0,3);

/* HARD fallback — guarantees links always render */
if(inlinePosts.length < 3){
inlinePosts = posts
.filter(p=>p.slug!==post.slug)
.slice(0,3);
}

const inlineRecs = inlinePosts
.map(p=>`<li><a href="${p.url}" class="post-title">${p.title}</a></li>`)
.join("");

const related = relatedPosts
.map(p=>`
<li>
<a href="${p.url}" class="related-link">
<img data-src="${p.thumb}" width="110" class="lazy" alt="${p.title}" />
<span class="related-title">${p.title} (~${p.readTime} min)</span>
</a>
</li>`).join("");

const category = post.category || "ai-writing-tools";
const categoryTitle = formatCategoryTitle(category);

const breadcrumbHTML = `
`;
const breadcrumbSchema = `
<script type="application/ld+json">
{
"@context":"https://schema.org",
"@type":"BreadcrumbList",
"itemListElement":[
{
"@type":"ListItem",
"position":1,
"name":"Home",
"item":"${SITE_URL}"
},
{
"@type":"ListItem",
"position":2,
"name":"AI Tools",
"item":"${SITE_URL}/ai-tools/"
},
{
"@type":"ListItem",
"position":3,
"name":"${categoryTitle}",
"item":"${SITE_URL}/ai-tools/${category}/"
},
{
"@type":"ListItem",
"position":4,
"name":"${escapeJson(post.title)}",
"item":"${post.url}"
}
]
}
</script>
`;

/* TOPIC CLUSTER BLOCK */
const clusterPosts = topics[post.category]
  .filter(p=>p.slug!==post.slug)
  .slice(0,5);

const clusterBlock = clusterPosts.length ? `
<section class="topic-cluster">
<h3>Explore More ${formatCategoryTitle(post.category)}</h3>
<ul>
${clusterPosts.map(p=>`
<li><a href="${p.url}">${p.title}</a></li>
`).join("")}
</ul>
</section>
` : "";
  
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="google-site-verification" content="JVwKXzn2GLXsQvxWNM1oDIehqkxZ_oa0I3kddnLnY1A" />
<meta name="msvalidate.01" content="EFCFE264BAC6BD46CDE25837ADBBBEEC" />
<meta name="robots" content="index, follow">
<title>${post.title}</title>
<link rel="canonical" href="${post.url}">
<link rel="preload" as="image" href="${post.og}">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
<meta name="description" content="${post.description}">
<meta property="og:title" content="${post.title}">
<meta property="og:description" content="${post.description}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="ReviewLab">
<meta property="og:url" content="${post.url}">
<meta property="og:image" content="${post.og}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${post.title}">
<meta name="twitter:description" content="${post.description}">
<meta name="twitter:image" content="${post.og}">

<script type="application/ld+json">
${post.schemas}
</script>
</head>
<body>
${globalHeader()}

<div class="container">
<div class="page-wrapper">
<div class="main-content post-page">

${breadcrumbHTML}
${breadcrumbSchema}
 
<article>
<h1 class="overhead">${post.title}</h1>
<div class="top-cta">
  <p><strong>🚀 Want the exact AI tool that’s making people money right now?</strong></p>
  <a href="javascript:void(0)" class="cta-btn">See #1 Tool →</a>
</div>

<p class="sub">
By <a href="${SITE_URL}/author/" rel="author">Justin Gerald</a> • ${post.readTime} min read
</p>

${post.isReview ? generateTrustBlock(post) : ""}
${post.isReview ? generateProductBox(post) : ""}

<section class="post-inline-email">
<p><strong>Want deeper AI tool breakdowns?</strong></p>

<form class="email-form" data-source="post">
<input type="email" placeholder="Your email" required>
<button type="submit">Send Me Future Reviews</button>
</form>

<p class="trust">No spam. Only tested tools.</p>
</section>

${tocHtml} 
${updatedHtml.replace(/(<p>.*?<\/p>){2}/, `$&`)}

<section class="mid-cta">
  <p><strong>Most AI tools are hype. This one actually converts.</strong></p>
  <a href="javascript:void(0)" class="cta-btn">See The Proven Tool →</a>

  <p class="mid-ctaa">
    Tested for real ROI — not just features.
  </p>
</section>

${clusterBlock}

<section class="reader-recommendations">
<h2>You May Also Like</h2>
<div class="recommendation-grid">
${generateRelatedReviews(post, posts)
.slice(0,6)
.map(item=>`
<div class="recommend-card">
<a href="${item.url}">
<img
loading="lazy"
src="${item.thumb}"
alt="${item.title}"
class="recommend-thumb"
width="680"
height="360">
<h3>${item.title}</h3>
<p>${item.description}</p>
</a>
</div>
`).join("")}
</div>
</section>

<section class="decision-cta">
  <h3>So… is this tool actually worth it?</h3>
  <p>If you want something that delivers real results, this is the one most people switch to.</p>

  <a href="javascript:void(0)" class="cta-btn">View Best Alternative →</a>
</section>
  
${post.isReview ? `
<section class="comparison-block">
<h3>Compare This Tool</h3>
<ul>
${(generatedComparisons.get(post.slug) || [])
.map(comp => `
<li>
<a href="${SITE_URL}/comparisons/${comp.slug}/">
${comp.title}
</a>
</li>
`).join("")}
</ul>
<p><strong>Don’t want to compare everything?</strong></p>
<a href="javascript:void(0)" class="cta-btn">See Best Tool →</a>
</section>
` : ""}

<section class="internal-widget">
<h3>Continue Reading</h3>
<ul class="internal-list">
${inlineRecs}
</ul>
</section>

<section class="money-cta">
<h3>Best AI Tool Right Now</h3>
<p>This tool is currently outperforming others in ROI and usability.</p>
<a href="${SITE_URL}/ai-tools/ai-writing-tools/" class="cta-btn">
View #1 Recommendation →
</a>
</section>

<h3 class="pagination">Related Reviews</h3>
<ul class="post-list">
${related}
</ul>

<img id="hoverPreview" class="hover-preview"/>

</article>

</div>

<aside class="sidebar">

<!-- 1. PRIMARY MONEY CTA (Sticky + Dynamic) -->
<div class="sidebar-card highlight sticky-main-cta">
  <h3>🚀 Start Making Money With This</h3>
  <p>Beginner-friendly system. No tech skills needed.</p>
  <a href="javascript:void(0)" class="sidebar-btn">Get Instant Access</a>
</div>

<!-- 2. SOCIAL PROOF -->
<div class="sidebar-card">
  <h3>💬 Real Results</h3>
  <p>Used by 3,000+ beginners generating passive income online.</p>
</div>

<!-- 4. EMAIL CAPTURE (SECONDARY) -->
<div class="sidebar-card">
  <h3>🎁 Free AI Tool Kit</h3>
  <p>Get the exact tools + workflows beginners use to generate income.</p>

  <form class="email-form" data-source="sidebar">
<input type="email" placeholder="Enter your email" required>
<button type="submit">Get Instant Access</button>
</form>

  <p class="sidebar-trust">
✔ Bonus guide sent instantly after signup<br>
📩 Didn’t see it? Check your Spam or Promotions tab<br>
✔ No spam. Only proven tools
</p>
</div>

<!-- 5. INTERNAL LINKS -->
<div class="sidebar-card">
  <h3>📚 Related Guides</h3>
  <ul>
    <li><a href="/ai-tools/">Best AI Tools for Beginners</a></li>
    <li><a href="/posts/">How I Made My First $100 Online</a></li>
    <li><a href="/ai-tools/automation-tools/">Top Passive Income Systems</a></li>
  </ul>
</div>

<!-- 6. CATEGORIES -->
<div class="sidebar-card">
  <h3>Categories</h3>
  <ul>
    <li><a href="/ai-tools/ai-writing-tools/">AI Writing</a></li>
    <li><a href="/ai-tools/ai-image-generators/">AI Image</a></li>
    <li><a href="/ai-tools/automation-tools/">Automation</a></li>
  </ul>
</div>

</aside>

</div>
</div>

<footer class="site-footer">

<div class="footer-links">
<a href="${SITE_URL}/">Home</a>
<a href="${SITE_URL}/about/">About</a>
<a href="${SITE_URL}/contact/">Contact</a>
<a href="${SITE_URL}/privacy/">Privacy Policy</a>
<a href="${SITE_URL}/editorial-policy/">Editorial Policy</a>
<a href="${SITE_URL}/review-methodology/">Review Methodology</a>
</div>

<p class="footer-copy">
© ${new Date().getFullYear()} ReviewLab. Independent AI software analysis.
</p>

</footer>

<script src="/assets/email.js"></script>

<script>
document.addEventListener("DOMContentLoaded",()=>{

const lazyImgs=document.querySelectorAll(".lazy");

const io=new IntersectionObserver(entries=>{
entries.forEach(e=>{
if(e.isIntersecting){
const img=e.target;
img.src=img.dataset.src;
img.onload=()=>img.classList.add("loaded");
io.unobserve(img);
}
});
});

lazyImgs.forEach(img=>io.observe(img));

const hover=document.getElementById("hoverPreview");

document.querySelectorAll(".related-link").forEach(link=>{

const img=link.querySelector("img");
let touchTimer;

link.addEventListener("mouseover",()=>{
hover.src=img.dataset.src;
hover.style.display="block";
});

link.addEventListener("mousemove",e=>{
hover.style.top=(e.pageY+20)+"px";
hover.style.left=(e.pageX+20)+"px";
});

link.addEventListener("mouseout",()=>hover.style.display="none");

link.addEventListener("touchstart", e=>{
  hover.src = img.dataset.src;
  hover.classList.add("hover-centered");
  setTimeout(()=>{
    hover.style.display="none";
    hover.classList.remove("hover-centered");
  },500);
});

link.addEventListener("touchend",()=>{
clearTimeout(touchTimer);
hover.style.display="none";
hover.classList.remove("hover-centered");
});

});

});

</script>

<script>
window.addEventListener("load", function(){
  // 1. Load the real post data from the backend
  const postPool = ${ctaJson}; 
  if (!postPool || postPool.length === 0) return;

  // The #1 "Best Tool" is always the very first item in the list
  const primaryPost = postPool[0];

  // 2. PROFESSIONAL CTA ROTATOR
  // This selects every button: top-cta, mid-cta, decision-cta, money-cta, and sidebar
  const allButtons = document.querySelectorAll(".cta-btn, .sidebar-btn");
  
  allButtons.forEach((btn, index) => {
    // We use the modulo (%) to cycle through the 5 posts 
    // so every button on the page points to a DIFFERENT real review.
    const assignedPost = postPool[index % postPool.length];
    
    btn.setAttribute("href", assignedPost.url);
    
    // Optional: Update button text to be more specific if it's a generic button
    if(btn.innerText.includes("See #1 Tool") || btn.innerText.includes("See Tool")) {
       btn.innerHTML = \`Check Out \${assignedPost.title} →\`;
    }
  });

  // 3. SCROLLING CTA (Always points to the #1 Best performing post)
  const strollCta = document.querySelector(".stroll-main-cta");
  if(strollCta) {
    window.addEventListener("scroll", function(){
      const scrollPercent = (window.scrollY / document.body.scrollHeight) * 100;
      if(scrollPercent > 35){
         if(!strollCta.classList.contains("active")){
            strollCta.classList.add("active");
            const link = strollCta.querySelector("a");
            if(link) {
              link.href = primaryPost.url;
              link.innerHTML = \`Top Choice: \${primaryPost.title} →\`;
            }
         }
      } else {
         strollCta.classList.remove("active");
      }
    });
  }

  // 4. EXIT POPUP (Promotes the #1 Best performing post)
  let popupShown = false;
  document.addEventListener("mouseleave", function(e){
    if(e.clientY > 0 || popupShown) return;
    popupShown = true;

    const popup = document.createElement("div");
    popup.className = "exit-popup-overlay";
    popup.innerHTML = \`
      <div class="exit-popup">
        <h3>Don't Miss Our #1 Recommendation</h3>
        <p>Our testing shows <strong>\${primaryPost.title}</strong> is currently delivering the best results.</p>
        <a href="\${primaryPost.url}" class="cta-btn">Read Full Review →</a>
        <span class="close-popup">✕</span>
      </div>\`;

    document.body.appendChild(popup);
    popup.querySelector(".close-popup").onclick = () => popup.remove();
  });
});
</script>

${post.isReview ? `
<div class="stroll-main-cta">
<h3>🚀 Recommended Tool</h3>
<p>Proven system beginners are using right now.</p>
<a href="javascript:void(0)" class="cta-btn">See Tool →</a>
</div>
` : ""}
</body>
</html>
`;

fs.writeFileSync(`_site/posts/${post.slug}/index.html`,page);
}

function copyStaticPage(slug, filePath){
if(!fs.existsSync(filePath)){
console.log(`⚠ Skipping missing file: ${filePath}`);
return;
}

let content = fs.readFileSync(filePath,"utf-8");

// Remove frontmatter
content = content.replace(/---[\s\S]*?---/,"").trim();

// Convert markdown to HTML
const htmlContent = marked.parse(content);

const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${slug.replace(/-/g," ")}</title>
<link rel="canonical" href="${SITE_URL}/${slug}/">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>
<body>
${globalHeader()}
<div class="container">
${htmlContent}
</div>
</body>
</html>
`;

fs.mkdirSync(`_site/${slug}`,{recursive:true});
fs.writeFileSync(`_site/${slug}/index.html`,html);
}

copyStaticPage("about","pages/about.md");
copyStaticPage("contact","pages/contact.md");
copyStaticPage("privacy","pages/privacy.md");
copyStaticPage("editorial-policy","pages/editorial-policy/index.md");
copyStaticPage("review-methodology","pages/review-methodology/index.md");

fs.mkdirSync(`_site/ai-tools`, { recursive: true });

const aiToolsList = Object.keys(topics)
.map(cat => `
<li>
<a href="${SITE_URL}/ai-tools/${cat}/">
${formatCategoryTitle(cat)} (${topics[cat].length})
</a>
</li>
`).join("");
fs.writeFileSync(`_site/ai-tools/index.html`, `

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Best AI Tools (Tested & Ranked)</title>
<meta name="description" content="Discover the best AI tools ranked by real testing, ROI, and performance.">
<link rel="canonical" href="${SITE_URL}/ai-tools/">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">

</head>
<body>
${globalHeader()}
<div class="container">

<h1>Best AI Tools (Tested & Ranked)</h1>

<p class="category-intro">
We test AI tools based on real-world performance, monetization potential, and workflow efficiency — not hype.
</p>

<!-- 🔥 TOP CTA -->
<section class="money-cta">
<h2>#1 Recommended AI Tool</h2>
<p>Currently the highest-performing tool based on ROI and usability.</p>
<a href="${SITE_URL}/ai-tools/ai-writing-tools/" class="cta-btn">
See #1 Tool →
</a>
</section>
                 
<!-- 🔥 CATEGORY GRID -->
<section class="hub-grid">
${Object.keys(topics).map(cat => `
<div class="hub-card">

<h3>
<a href="${SITE_URL}/ai-tools/${cat}/">
${formatCategoryTitle(cat)}
</a>
</h3>

<p>Explore top-performing tools in this category.</p>

<a href="${SITE_URL}/ai-tools/${cat}/" class="cta-btn">
View Tools →
</a>

</div>
`).join("")}
</section>

<!-- 🔥 TRUST BLOCK -->
<div class="author-box">
<p>
All tools are tested based on structured methodology, real use cases, and monetization viability.
No paid placements. No inflated rankings.
</p>
</div>

</div>
</body>
</html>
`);

/* BUILD CATEGORY (AI TOOLS) PAGES — RUN ONCE */
for (const topic in topics) {
  const list = topics[topic]
    .map(p => `<li><a href="${p.url}">${p.title}</a></li>`)
    .join("");

  const topicTitle = formatCategoryTitle(topic);
  const topicURL = `${SITE_URL}/ai-tools/${topic}/`;

  const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${topicTitle}</title>
<link rel="canonical" href="${topicURL}">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
<meta name="description" content="Expert reviews and comparisons for ${topicTitle}.">
</head>
<body>
${globalHeader()}
<div class="container">

<h1>${topicTitle}</h1>

<p class="category-intro">
Comprehensive analysis of ${topicTitle} based on structured testing methodology,
feature benchmarking, and real-world implementation workflows.
</p>

<section class="hub-grid">
${topics[topic]
.slice(0,6)
.map(p=>`
<div class="hub-card">

<h3>
  <a href="${p.url}">
    ${escapeJson(p.title)}
  </a>
</h3>

<p>${p.description}</p>
</div>
`).join("")}
</section>

<h2>All Reviews</h2>
<ul class="clean-list">
${list}
</ul>
</div>
</body>
</html>
`;

  const outputDir = `_site/ai-tools/${topic}`;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(`${outputDir}/index.html`, html);
}

generatePostSitemap(posts);
generatePageSitemap();
generateCategorySitemap(topics);
generateComparisonSitemap();
generateTagSitemap();
generateSitemapIndex();

/* =========================
   TAG TAXONOMY ENGINE
========================= */
const tags = {};

posts.forEach(post=>{
const words = post.title.toLowerCase().split(/\W+/);

words.forEach(word=>{
if(word.length < 5) return;

if(!tags[word]) tags[word]=[];

tags[word].push(post);
});
});

/* Build tag pages */
for(const tag in tags){
if(tags[tag].length < 2) continue;

const list = tags[tag]
.map(p=>`<li><a href="${p.url}">${p.title}</a></li>`)
.join("");

const dir = `_site/tag/${tag}`;
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(`${dir}/index.html`,`

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${tag} Reviews</title>
<link rel="canonical" href="${SITE_URL}/tag/${tag}/">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>
<body>
${globalHeader()}
<div class="container">
<h1>${tag} Reviews</h1>
<ul>
${list}
</ul>
</div>
</body>
</html>
`);
}

/* FULL AUTHORITY AUTHOR PAGE RESTORED */
const authorPosts = posts.map(p=>`
<li class="post-card">
  <a href="${p.url}" class="post-link">
    <img src="${p.thumb}" class="thumb" alt="${p.title}">
    <div>
      <div class="post-title">${p.title}</div>
      <div class="meta">${p.readTime} min read</div>
    </div>
  </a>
</li>
`).join("");

fs.mkdirSync(`_site/author`,{recursive:true});
fs.writeFileSync(`_site/author/index.html`,`

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Justin Gerald — Product Review Analyst</title>
<link rel="canonical" href="${SITE_URL}/author/">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "Justin Gerald",
  "url": "${SITE_URL}/author/",
  "jobTitle": "AI Software Analyst",
  "description": "Independent AI software analyst specializing in structured testing methodology, monetization analysis, and workflow evaluation.",
  "knowsAbout": [
    "AI software reviews",
    "SaaS monetization",
    "AI automation tools",
    "AI writing tools",
    "AI image generation tools"
  ],
  "sameAs": [
    "https://www.youtube.com/@Review2Lab",
    "https://x.com/justingerad80500",
    "https://www.plurk.com/justingerad05",
    "https://github.com/justingerad05"
  ]
}

</script>
</head>
<body>
${globalHeader()}
<div class="container">

<h1 class="author-title">Justin Gerald</h1>

<p class="author-sub">
AI Software Analyst | Structured Testing & Monetization Research
</p>

<div class="author-box">
<p>
Justin Gerald is the founder of ReviewLab, an independent AI software research platform 
focused on structured testing methodology, feature verification, competitive positioning, 
and monetization viability analysis.
</p>

<p>
Each published review is based on:
</p>

<ul>
<li>Hands-on product evaluation</li>
<li>Workflow integration testing</li>
<li>Competitive feature benchmarking</li>
<li>ROI and monetization modeling</li>
</ul>

<p>
ReviewLab does not publish anonymous reviews or automated ratings.
All analysis is independently structured and manually evaluated.
</p>
</div>

<h2>Latest Reviews</h2>
<ul class="post-list">
${authorPosts}
</ul>

</div>
</body>
</html>
`);

fs.writeFileSync("_site/_data/posts.json",JSON.stringify(posts,null,2));

const searchIndex = posts.map(p=>({
  title:p.title,
  url:p.url,
  category:p.category,
  description:p.description
}));

fs.writeFileSync("_site/search-index.json", JSON.stringify(searchIndex));

fs.writeFileSync("_site/robots.txt",`
User-agent: *
Allow: /
Disallow: /page/

Sitemap: ${SITE_URL}/sitemap.xml
`);

fs.copyFileSync("assets/styles.css","_site/assets/styles.css");
fs.copyFileSync("assets/og-default.jpg","_site/assets/og-default.jpg");
fs.copyFileSync("assets/og-cta-tested.jpg","_site/assets/og-cta-tested.jpg");
fs.copyFileSync("assets/email.js","_site/assets/email.js");

/* =========================
   HOMEPAGE + PAGINATION
========================= */
for(let page=1; page<=totalPages; page++){
const start = (page-1)*POSTS_PER_PAGE;
const end = start+POSTS_PER_PAGE;
const pagePosts = posts.slice(start,end);
const homepagePosts = pagePosts.map(post => `
<li class="post-card" data-category="${post.category}">
  <a href="${post.url}" class="post-link">
    
    <img data-src="${post.thumb}" 
         alt="${post.title}" 
         class="thumb lazy">
    
    <div>
      <div class="post-title">
        ${post.title}
      </div>
      <div class="meta">
        Published ${new Date(post.date).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})}
      </div>
    </div>

  </a>
</li>
`).join("");

const pagination = `
<div class="pagination">
${page>1?`<a href="${page===2?`${SITE_URL}/`:`${SITE_URL}/page/${page-1}/`}">← Prev</a>`:''}
${page<totalPages?`<a style="float:right" href="${SITE_URL}/page/${page+1}/">Next →</a>`:''}
</div>
`;

const homepage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<title>ReviewLab – Honest AI Tool Reviews</title>
<meta name="description" content="ReviewLab publishes deeply tested AI software reviews.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="google-site-verification" content="JVwKXzn2GLXsQvxWNM1oDIehqkxZ_oa0I3kddnLnY1A" />
<meta name="msvalidate.01" content="EFCFE264BAC6BD46CDE25837ADBBBEEC" />
<meta name="robots" content="index, follow">
<link rel="canonical" href="${SITE_URL}/">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">

<script type="application/ld+json">
[
{
"@context":"https://schema.org",
"@type":"WebSite",
"name":"ReviewLab",
"url":"${SITE_URL}",
"potentialAction":{
"@type":"SearchAction",
"target":"${SITE_URL}/?q={search_term_string}",
"query-input":"required name=search_term_string"
}
},
{
"@context":"https://schema.org",
"@type":"ItemList",
"itemListElement":[
${pagePosts.map((post,i)=>`
{
"@type":"ListItem",
"position":${i+1},
"name":"${post.title}",
"url":"${post.url}"
}`).join(",")}
]
}
]
</script>

</head>
<body class="homepage-bg homepage-root">
${globalHeader()}
<div class="container home-hero">
<div class="search-filter-bar">

<input type="text" id="searchInput" placeholder="Search reviews..." class="search-input">

<select id="categoryFilter" class="category-select">
<option value="all">All Categories</option>
<option value="ai-writing-tools">AI Writing</option>
<option value="ai-image-generators">AI Image</option>
<option value="automation-tools">Automation</option>
</select>

</div>

<h1>Independent AI Software Reviews & Monetization Analysis</h1>

<h2 class="hero-authority">
Structured testing. Real implementation. Zero hype.
</h2>

<p class="sub">
Review Lab analyzes AI tools based on performance, usability,
and real-world monetization potential — not marketing claims.
</p>

<div class="trust-bar">
  <div>✔ Independent Analysis</div>
  <div>✔ Structured Testing Framework</div>
  <div>✔ No Anonymous Authors</div>
  <div>✔ ROI-Focused Reviews</div>
</div>

<section class="email-capture">
<h3>Get AI Tools Worth Using</h3>
<p>Only performance-tested software with real implementation value.
No spam. No affiliate-first bias.</p>

<p style="font-size:14px; color:#64748b;">
Join 1,000+ readers discovering AI tools that actually generate income.
</p>

<form class="email-form" data-source="homepage">
<div class="form-row">
<input type="email" placeholder="Enter your email address" required>
<button type="submit">Get Free Reviews</button>
</div>
</form>

</section>

<ul class="post-list">
${homepagePosts}
</ul>

${pagination}

</div>

<script>
document.addEventListener("DOMContentLoaded", function(){

const filter = document.getElementById("categoryFilter");
const searchInput = document.getElementById("searchInput");

if(filter){
filter.addEventListener("change", function(){
const val = this.value;

document.querySelectorAll(".post-card").forEach(card=>{
if(val==="all"){
card.style.display="flex";
}else{
card.style.display = card.dataset.category===val ? "flex" : "none";
}
});
});
}

if(searchInput){
searchInput.addEventListener("keyup", function(){
const value = this.value.toLowerCase();

document.querySelectorAll(".post-card").forEach(card=>{
const text = card.innerText.toLowerCase();
card.style.display = text.includes(value) ? "flex" : "none";
});
});
}

/* Lazy load */

const lazyImgs=document.querySelectorAll(".lazy");

const io=new IntersectionObserver(entries=>{
entries.forEach(e=>{
if(e.isIntersecting){
const img=e.target;
img.src=img.dataset.src;
img.onload=()=>img.classList.add("loaded");
io.unobserve(img);
}
});
});

lazyImgs.forEach(img=>io.observe(img));

});
</script>

<script src="${SITE_URL}/assets/email.js"></script>

</body>
</html>
`;

fs.copyFileSync("assets/hero-bg.webp","_site/assets/hero-bg.webp");
fs.mkdirSync(`_site/search`,{recursive:true});
fs.writeFileSync(`_site/search/index.html`,`

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<title>Search Reviews</title>
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>
<body class="${page === 1 ? "homepage-bg homepage-root" : ""}">
${globalHeader()}
<div class="container">

<h1>Search Reviews</h1>
<input type="text" id="searchBox" class="search-input" placeholder="Search..." class="search">
<ul id="results" class="post-list"></ul>
</div>

<script>
let posts = [];

fetch("/search-index.json")
.then(res=>res.json())
.then(data=>{
  posts = data;
});

const box = document.getElementById("searchBox");
const results = document.getElementById("results");

box.addEventListener("keyup",function(){
const val=this.value.toLowerCase();
results.innerHTML="";

posts
.filter(p=>p.title.toLowerCase().includes(val))
.slice(0,20)
.forEach(p=>{
results.innerHTML+=\`<li><a href="\${p.url}" class="post-title">\${p.title}</a></li>\`;
});
});
</script>
</body>
</html>
`);

const outputPath = page===1
? "_site/index.html"
: `_site/page/${page}/index.html`;

if(page!==1){
fs.mkdirSync(`_site/page/${page}`,{recursive:true});
}
fs.writeFileSync(outputPath, homepage);
}

fs.mkdirSync("_site/admin", { recursive: true });
fs.copyFileSync("admin/index.html", "_site/admin/index.html");

console.log("✅ Verification: Files in _site/posts/ are:", fs.readdirSync("_site/posts"));
console.log("✅ Homepage + Pagination Built Successfully");

/* AUTOMATIC CACHE PURGE */
async function purgeCloudflareCache() {
  const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID; 
  const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

  if (!API_TOKEN || !ZONE_ID) {
    console.log("⚠ Skipping purge: Missing API_TOKEN or ZONE_ID env variables.");
    return;
  }

  console.log(`Attempting to purge cache for Zone: ${ZONE_ID}...`);

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ purge_everything: true })
    });

    const result = await response.json();
    
    if (result.success) {
      console.log("✅ SUCCESS: Cloudflare cache purged!");
    } else {
      console.error("❌ FAILED: Cloudflare API returned errors:");
      console.error(JSON.stringify(result.errors, null, 2));
    }
  } catch (err) {
    console.error("❌ CRITICAL ERROR during cache purge:", err.message);
  }
}

await purgeCloudflareCache();
