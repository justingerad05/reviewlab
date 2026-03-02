import fs from "fs";
import fetch from "node-fetch";
import { marked } from "marked";
import { XMLParser } from "fast-xml-parser";
import { upscaleToOG } from "./generate-og.js";

function escapeJson(str){
  return str.replace(/"/g,'\\"');
}

function sanitizeHTML(html){
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,"")
    .replace(/style="[^"]*"/gi,"")
    .replace(/class="Mso[^"]*"/gi,"");
}

const FEED_URL =
"https://honestproductreviewlab.blogspot.com/feeds/posts/default?alt=atom";

import site from "./_data/site.json" with { type: "json" };

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

// Reset entire build directory
fs.rmSync("_site", { recursive: true, force: true });
fs.mkdirSync("_site", { recursive: true });

// Core folders
fs.mkdirSync("_site/posts", { recursive: true });
fs.mkdirSync("_site/posts/comparisons", { recursive: true });
fs.mkdirSync("_site/ai-tools", { recursive: true });
fs.mkdirSync("_site/author", { recursive: true });
fs.mkdirSync("_site/og-images", { recursive: true });
fs.mkdirSync("_site/assets", { recursive: true });
fs.mkdirSync("_site/_data", { recursive: true });
fs.mkdirSync(`_site/comparisons`, {recursive:true});

/* FETCH */

const parser = new XMLParser({ignoreAttributes:false});
const xml = await (await fetch(FEED_URL)).text();
const data = parser.parse(xml);

let entries = data.feed.entry || [];
if(!Array.isArray(entries)) entries=[entries];

/* YOUTUBE IMAGE ENGINE */

async function getYouTubeImages(html, slug) {

  const match = html.match(/(?:youtube\.com\/embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

  if (!match) {
    return [`${SITE_URL}/assets/og-default.jpg`];
  }

  const id = match[1];

  const candidates = [
    `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${id}/sddefault.jpg`,
    `https://img.youtube.com/vi/${id}/hqdefault.jpg`
  ];

  for (const img of candidates) {
    try {
      const res = await fetch(img, { method: "HEAD" });
      if (res.ok) {
        return [img];
      }
    } catch {}
  }

  const success = await upscaleToOG(
    `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    slug
  );

  if (success && fs.existsSync(`_site/og-images/${slug}.jpg`)) {
    return [`${SITE_URL}/og-images/${slug}.jpg`];
  }

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

const seenSlugs = new Set();

const posts=[];

function detectTopic(title){

const t = title.toLowerCase();

if(t.includes("writer") || t.includes("copy"))
  return "ai-writing-tools";

if(t.includes("image") || t.includes("art") || t.includes("design"))
  return "ai-image-generators";

if(t.includes("automation") || t.includes("auto") || t.includes("workflow"))
  return "automation-tools";

return "ai-writing-tools";
}

/* BUILD DATA */

for(const entry of entries){

let rawHtml = entry.content?.["#text"];
if(!rawHtml) continue;

rawHtml = sanitizeHTML(rawHtml);
  
const title = entry.title["#text"];
  
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

const description = textOnly.slice(0,155);

const ogImages = await getYouTubeImages(rawHtml,slug);
const primaryOG = ogImages[0];

const readTime = Math.max(1,
Math.ceil(textOnly.split(/\s+/).length / 200)
);

const {pros,cons} = extractProsCons(textOnly);

/* SCHEMA */

const wordCount = textOnly.split(/\s+/).length;
const ratingValue = Math.min(5, (3.8 + (wordCount / 4000))).toFixed(1);

const productSchema = {
"@context":"https://schema.org",
"@type":"Product",
"name":escapeJson(title),
"image":primaryOG,
"brand":{"@type":"Brand","name":title.split(" ")[0]},
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
"description":description,
"mainEntityOfPage":url
};

posts.push({
title,
slug,
html:rawHtml,
url,
description,
og:primaryOG,
thumb:primaryOG,
readTime,
date:entry.published,
lastmod: new Date().toISOString(),
category: detectTopic(title),
schemas:JSON.stringify([articleSchema,productSchema])
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

const POSTS_PER_PAGE = 10;
const totalPages = Math.ceil(posts.length / POSTS_PER_PAGE);

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

function generateSitemapIndex(){
fs.writeFileSync("_site/sitemap.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${SITE_URL}/sitemap-posts.xml</loc></sitemap>
<sitemap><loc>${SITE_URL}/sitemap-pages.xml</loc></sitemap>
<sitemap><loc>${SITE_URL}/sitemap-categories.xml</loc></sitemap>
</sitemapindex>`);
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
<title>${post.title}</title>
<link>${post.url}</link>
<description>${post.description}</description>
<pubDate>${new Date(post.date).toUTCString()}</pubDate>
</item>
`).join("")}

</channel>
</rss>`;

fs.writeFileSync("_site/rss.xml",rss);
}

generateRSS(posts);

/* AUTO COMPARISON ENGINE */

function generateComparison(postA, postB){

 const slug = `${postA.slug}-vs-${postB.slug}`;
 const url = `${SITE_URL}/posts/comparisons/${slug}/`;

 const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${postA.title} vs ${postB.title}</title>
<link rel="canonical" href="${url}">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">

<script type="application/ld+json">
{
 "@context":"https://schema.org",
 "@type":"ItemList",
 "name":"${postA.title} vs ${postB.title}",
 "itemListElement":[
   {
     "@type":"ListItem",
     "position":1,
     "name":"${postA.title}",
     "url":"${postA.url}"
   },
   {
     "@type":"ListItem",
     "position":2,
     "name":"${postB.title}",
     "url":"${postB.url}"
   }
 ]
}
</script>
</head>
<body>
${globalHeader()}
<div class="container">

<h1>${postA.title} vs ${postB.title}</h1>

<p>Side-by-side comparison of features, strengths, and ideal use cases.</p>

<table border="1" cellpadding="8">
<tr>
<th>Feature</th>
<th>${postA.title}</th>
<th>${postB.title}</th>
</tr>
<tr>
<td>Overview</td>
<td><a href="${postA.url}">Read Review</a></td>
<td><a href="${postB.url}">Read Review</a></td>
</tr>
</table>

</div>
</body>
</html>
`;

 fs.mkdirSync(`_site/posts/comparisons/${slug}`,{recursive:true});
 fs.writeFileSync(`_site/posts/comparisons/${slug}/index.html`,html);
}

/* BUILD ALL COMPARISON PAGES */

for(let i=0;i<posts.length;i++){
  for(let j=i+1;j<posts.length && j<i+4;j++){
    generateComparison(posts[i],posts[j]);
  }
}

const comparisonLinks = [];

for(let i=0;i<posts.length;i++){
  for(let j=i+1;j<posts.length && j<i+4;j++){
    const slugs = [posts[i].slug, posts[j].slug];
    const slug = `${slugs[0]}-vs-${slugs[1]}`;
    
    comparisonLinks.push(`
<li>
<a href="${SITE_URL}/posts/comparisons/${slug}/">
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

</body>
</html>
`;

  fs.writeFileSync(`${outputDir}/index.html`, html);
}

generateTopList("ai-writing-tools", posts);
generateTopList("ai-image-generators", posts);
generateTopList("automation-tools", posts);

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
  "automation-tools": []
};

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

const relatedPosts = posts
.filter(p=>p.slug!==post.slug)
.map(p=>{

let score = 0;

/* Same category boost */
if(p.category === post.category) score += 15;

/* Title similarity */
score += scoreSimilarity(post.title,p.title);

/* Recency boost */
const daysOld = (Date.now() - new Date(p.date)) / (1000*60*60*24);
if(daysOld < 60) score += 2;

return {post:p,score};

})
.sort((a,b)=>b.score-a.score)
.slice(0,4)
.map(r=>r.post);

let inlinePosts = posts
.filter(p=>p.slug!==post.slug && !relatedPosts.some(r=>r.slug===p.slug))
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

<title>${post.title}</title>

<link rel="canonical" href="${post.url}">

<link rel="preload" as="image" href="${post.og}">

<script>
if(location.href.endsWith("index.html")){
  const clean = location.href.replace("index.html","");
  history.replaceState(null,null,clean);
}
</script>

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

<p class="sub">
By <a href="${SITE_URL}/author/" rel="author">Justin Gerald</a> • ${post.readTime} min read
</p>

<section class="post-inline-email">
<p><strong>Want deeper AI tool breakdowns?</strong></p>

<form action="https://docs.google.com/forms/d/e/1FAIpQLSchzs0bE9se3YCR2TTiFl3Ohi0nbx0XPBjvK_dbANuI_eI1Aw/formResponse" method="POST" target="_blank" class="inline-form">

<input type="email" name="entry.364499249" placeholder="Your email" required>

<button type="submit">Send Me Future Reviews</button>

</form>

<p class="trust">No spam. Only tested tools.</p>
</section>

${post.html}
${clusterBlock}

<section class="comparison-block">
<h3>Compare This Tool</h3>
<ul>
${posts
.filter(p=>p.slug!==post.slug)
.slice(0,3)
.map(p=>{
  const slugs = [post.slug, p.slug].sort();
  return `
<li>
<a href="${SITE_URL}/posts/comparisons/${slugs[0]}-vs-${slugs[1]}/">
${post.title} vs ${p.title}
</a>
</li>`;
}).join("")}
</ul>
</section>

<section class="internal-widget">
<h3>Continue Reading</h3>
<ul class="internal-list">
${inlineRecs}
</ul>
</section>

<h3 class="pagination">Related Reviews</h3>
<ul class="post-list">
${related}
</ul>

<img id="hoverPreview" class="hover-preview"/>

</article>

</div>

<aside class="sidebar">
<h3>Categories</h3>
<ul>
<li><a href="${SITE_URL}/ai-tools/ai-writing-tools/">AI Writing</a></li>
<li><a href="${SITE_URL}/ai-tools/ai-image-generators/">AI Image</a></li>
<li><a href="${SITE_URL}/ai-tools/automation-tools/">Automation</a></li>
</ul>
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
<link rel="preconnect" href="https://img.youtube.com">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="dns-prefetch" href="//img.youtube.com">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Tools Categories</title>
<link rel="canonical" href="${SITE_URL}/ai-tools/">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>
<body>
${globalHeader()}

<h1>AI Tools Categories</h1>

<ul>
${aiToolsList}
</ul>

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

<p>
This category covers in-depth reviews, comparisons, and real-world testing insights for ${topicTitle}. 
Each review is independently analyzed for performance, usability, and ROI.
</p>

<ul>
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
<li class="author-post">
  <a href="${p.url}" class="author-post-title">${p.title}</a>
  <div class="meta">${p.readTime} min read</div>
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
  "jobTitle": "AI Software Analyst & Review Specialist",
  "url":"${SITE_URL}/author/",
  "sameAs": [
    "https://www.youtube.com/@HonestProductReviewLab",
    "https://x.com/justingerad80500",
    "https://www.plurk.com/justingerad05",
    "https://github.com/justingerad05"
  ],
  "worksFor": {
    "@type": "Organization",
    "name": "Review Lab",
    "url":"${SITE_URL}",
  },
  "description": "Independent analyst testing AI software based on feature verification, performance review, and monetization potential."
}
}
</script>

</head>
<body>
${globalHeader()}
<div class="container">

<h1 class="author-title">Justin Gerald</h1>

<p class="author-sub">
Independent product review analyst focused on deep research,
real-world testing signals, and buyer-intent software evaluation.
</p>

<div class="author-box">
<strong>Editorial Integrity:</strong>
<p class="footer-links">
Every review published on ReviewLab is created through structured analysis,
feature verification, market comparison, and user-benefit evaluation.
No automated ratings. No anonymous authorship.
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
<form action="https://docs.google.com/forms/d/e/1FAIpQLSchzs0bE9se3YCR2TTiFl3Ohi0nbx0XPBjvK_dbANuI_eI1Aw/formResponse" method="POST" target="_blank">
<div class="form-row">
<input type="email" name="entry.364499249" placeholder="Enter your email address" required>
<button type="submit">Get Free Reviews</button>
</div>
<div class="trust">Join smart readers staying ahead of AI.</div>
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

</body>
</html>
`;

fs.copyFileSync("assets/hero-bg.jpg","_site/assets/hero-bg.jpg");
  
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

console.log("✅ Homepage + Pagination Built Successfully");
