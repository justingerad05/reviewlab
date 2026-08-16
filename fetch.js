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

/* =========================================================
   REVIEWLAB — PERMANENT DATA + AUTHORITY ENGINE
   ========================================================= */

function getReviewData(productSlug){
  return reviewsData.find(
    item => item.productSlug === productSlug
  ) || {};
}

function getVersionHistory(productSlug){
  const item = versions.find(
    item => item.productSlug === productSlug
  );

  return item?.history || [];
}

function getAuthorData(slug = "justin-gerald"){
  return authors.find(
    author => author.slug === slug
  ) || authors[0] || {};
}

function getEntityData(){
  return Array.isArray(entities) ? entities : [];
}

function escapeHtml(value = ""){
  return safeString(value)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function stripHtml(value = ""){
  return safeString(value).replace(/<[^>]*>/g," ");
}

function cleanText(value = ""){
  return stripHtml(value)
    .replace(/\s+/g," ")
    .trim();
}

/* =========================================================
   HEADING-BASED PROS / CONS ENGINE
   ========================================================= */

function extractHeadingSection(html, headingNames = []){
  const source = safeString(html);

  const pattern = headingNames
    .map(x => x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"))
    .join("|");

  const regex = new RegExp(
    `<h[2-4][^>]*>\\s*(?:${pattern})\\s*<\\/h[2-4]>([\\s\\S]*?)(?=<h[2-4][^>]*>|$)`,
    "i"
  );

  const match = source.match(regex);

  if(!match) return [];

  const listItems = [...match[1].matchAll(
    /<li[^>]*>([\s\S]*?)<\/li>/gi
  )]
  .map(m => cleanText(m[1]))
  .filter(Boolean);

  if(listItems.length){
    return listItems.slice(0,6);
  }

  const paragraphs = [...match[1].matchAll(
    /<p[^>]*>([\s\S]*?)<\/p>/gi
  )]
  .map(m => cleanText(m[1]))
  .filter(Boolean);

  return paragraphs.slice(0,6);
}

function extractStructuredProsCons(html, product){
  let pros = extractHeadingSection(
    html,
    ["Pros","Advantages","Benefits","What I Like","Strengths"]
  );

  let cons = extractHeadingSection(
    html,
    ["Cons","Disadvantages","Limitations","Drawbacks","What I Don't Like","Weaknesses"]
  );

  /* Product database is fallback only */
  if(!pros.length){
    pros = safeArray(product?.pros);
  }

  if(!cons.length){
    cons = safeArray(product?.cons);
  }

  return {
    pros: [...new Set(pros)].slice(0,6),
    cons: [...new Set(cons)].slice(0,6)
  };
}

function extractLabeledValue(html, labels = []){
  const text = cleanText(html);

  if(!text || !labels.length) return "";

  const escapedLabels = labels
    .map(label =>
      safeString(label)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("|");

  /*
    Stop at the next known metadata label.

    This allows metadata such as:

    Product Version: 4.2
    Test Duration: 18 Days
    Platforms: Windows, Mac, Web
    Reviewed by: Justin Gerald

    to be extracted independently even after cleanText()
    removes the original line breaks.
  */
  const metadataLabels =
    "(?:Product\\s+Version|Version|Current\\s+Version|Test\\s+Duration|Testing\\s+Duration|Tested\\s+For|Testing\\s+Period|Platforms?|Platform|Reviewed\\s+By|Reviewed\\s+by|Author|Price|Pricing|Trial|Refund)";

  const regex = new RegExp(
    `(?:${escapedLabels})\\s*[:\\-]?\\s*([\\s\\S]*?)(?=\\s+${metadataLabels}\\s*[:\\-]|$)`,
    "i"
  );

  const match = text.match(regex);

  if(!match?.[1]) return "";

  return match[1]
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[|]+$/g, "")
    .trim();
}

/* =========================================================
   REAL REVIEW SCORE ENGINE
   ========================================================= */

function extractScoreFromContent(html, label){
  const text = cleanText(html);

  const regex = new RegExp(
    `${label}[^0-9]{0,30}(10|[0-9](?:\\.\\d+)?)\\s*(?:\\/\\s*10|out of 10)?`,
    "i"
  );

  const match = text.match(regex);

  if(!match) return null;

  const value = Number(match[1]);

  return Number.isFinite(value)
    ? Math.min(10,Math.max(0,value))
    : null;
}

function extractReviewMetadata(title, html, labels = [], fallbackCategory = ""){
  const text = cleanText(html);
  const source = `${title}\n${text}`;

  const firstMatch = patterns => {
    for(const pattern of patterns){
      const match = source.match(pattern);
      if(match && match[1]) return match[1].trim();
    }
    return "";
  };

  let productName = firstMatch([
    /(?:^|\n|\b)Product(?: Name)?\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Tool(?: Name)?\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Software(?: Name)?\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Reviewed Product\s*:\s*([^\n|•]+)/i
  ]);

  if(!productName){
    const headingMatch = html.match(/<h[1-3][^>]*>\s*([^<]{2,100}?)\s*(?:Review|Testing|Test|Overview|Analysis)\s*<\/h[1-3]>/i);
    if(headingMatch && headingMatch[1]) productName = cleanText(headingMatch[1]);
  }

  const website = firstMatch([
    /(?:^|\n|\b)(?:Website|Official Website|Product Website)\s*:\s*(https?:\/\/[^\s<]+)/i
  ]);

  const version = firstMatch([
    /(?:^|\n|\b)Product\s+Version\s*:\s*([0-9]+(?:\.[0-9]+){0,3})/i,
    /(?:^|\n|\b)Version\s*:\s*([0-9]+(?:\.[0-9]+){0,3})/i,
    /(?:^|\n|\b)Ver\.?\s*[:#-]?\s*([0-9]+(?:\.[0-9]+){0,3})/i
  ]);

  const testDuration = firstMatch([
    /(?:^|\n|\b)Test\s+Duration\s*:\s*([0-9]+\s*(?:day|days|week|weeks|month|months))/i,
    /(?:^|\n|\b)Tested\s+for\s+([0-9]+\s*(?:day|days|week|weeks|month|months))/i,
    /(?:^|\n|\b)Testing\s+Duration\s*:\s*([0-9]+\s*(?:day|days|week|weeks|month|months))/i
  ]);

  const reviewedBy = firstMatch([
    /(?:^|\n|\b)Reviewed\s+by\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Tested\s+by\s*:\s*([^\n|•]+)/i
  ]);

  const rawPlatforms = firstMatch([
    /(?:^|\n|\b)Platforms?\s*:\s*([^\n]+)/i,
    /(?:^|\n|\b)Platform\s*:\s*([^\n]+)/i
  ]);

  const platformNames = ["Windows","Mac","Web","Mobile","iOS","Android","Linux","ChromeOS"];
  const platforms = platformNames.filter(platform =>
    new RegExp(`\\b${platform.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\$&")}\\b`,"i")
      .test(rawPlatforms || text)
  );

  const price = firstMatch([
    /(?:^|\n|\b)Price\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Pricing\s*:\s*([^\n|•]+)/i
  ]) || ((text.match(/(?:[$€£₦]\s*)[0-9][0-9,]*(?:\.[0-9]{1,2})?(?:\s*\/\s*(?:month|mo|year|yr|week|one[- ]time))?/i) || [""])[0]);

  const categoryText = firstMatch([
    /(?:^|\n|\b)Category\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Niche\s*:\s*([^\n|•]+)/i
  ]);

  const trialText = firstMatch([
    /(?:^|\n|\b)Trial\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Free\s+Trial\s*:\s*([^\n|•]+)/i
  ]);

  const refundText = firstMatch([
    /(?:^|\n|\b)Refund\s*:\s*([^\n|•]+)/i,
    /(?:^|\n|\b)Money[- ]Back\s*:\s*([^\n|•]+)/i
  ]);

  const normalizeCategory = value => {
    const v = safeLower(value).replace(/[_-]+/g," ").replace(/\s+/g," ").trim();
    if(/voice|speech|audio|text to speech|tts/.test(v)) return "ai-voice-tools";
    if(/image|art|design|photo/.test(v)) return "ai-image-generators";
    if(/automation|workflow|agent|integration/.test(v)) return "automation-tools";
    if(/writing|copy|content|seo/.test(v)) return "ai-writing-tools";
    return "";
  };

  const category = normalizeCategory(categoryText) || normalizeCategory(labels.join(" ")) || fallbackCategory || "";

  return {
    productName: productName.replace(/\s+$/,""),
    website: website.replace(/[),.;]+$/,""),
    version,
    testDuration,
    reviewedBy,
    platforms,
    price,
    category,
    trial: trialText ? !/no|none|not available|n\/a/i.test(trialText) : /\bfree trial\b|\btrial\b/i.test(text),
    refund: refundText ? !/no|none|not available|n\/a/i.test(refundText) : /\brefund\b|\bmoney[- ]back\b/i.test(text)
  };
}

function evidenceDimensionScore(text, positivePatterns, negativePatterns, base = 5){
  let score = base;
  let positive = 0;
  let negative = 0;

  for(const pattern of positivePatterns){
    const matches = text.match(pattern);
    if(matches) positive += Math.min(3,matches.length);
  }

  for(const pattern of negativePatterns){
    const matches = text.match(pattern);
    if(matches) negative += Math.min(3,matches.length);
  }

  score += Math.min(3,positive) - Math.min(3,negative);
  return Math.max(1,Math.min(10,Number(score.toFixed(1))));
}

function deriveReviewDimensions({html, product, pros = [], cons = []}){
  const text = cleanText(html).toLowerCase();
  const prosText = safeArray(pros).join(" ").toLowerCase();
  const consText = safeArray(cons).join(" ").toLowerCase();
  const evidence = `${text} ${prosText} ${consText}`;

  const dimensions = {
    features: evidenceDimensionScore(
      evidence,
      [/\bfeature\w*\b/g,/\btemplate\w*\b/g,/\btool\w*\b/g,/\bfunction\w*\b/g,/\bcapabilit\w*\b/g],
      [/\bmissing\b/g,/\black(?:s|ing)?\b/g,/\blimited\b/g]
    ),
    easeOfUse: evidenceDimensionScore(
      evidence,
      [/\beasy\b/g,/\beasier\b/g,/\bsimple\b/g,/\bintuitive\b/g,/\buser[- ]friendly\b/g,/\bquickly\b/g],
      [/\bconfusing\b/g,/\bdifficult\b/g,/\bcomplicated\b/g,/\bsteep learning\b/g,/\bfriction\b/g]
    ),
    pricing: evidenceDimensionScore(
      evidence,
      [/\baffordable\b/g,/\bgood value\b/g,/\bworth the price\b/g,/\bvalue\b/g,/\bcheap\b/g,/\breasonable\b/g],
      [/\bexpensive\b/g,/\boverpriced\b/g,/\bcostly\b/g,/\bpricey\b/g,/\btoo expensive\b/g]
    ),
    support: evidenceDimensionScore(
      evidence,
      [/\bsupport\b/g,/\bcustomer service\b/g,/\bhelp center\b/g,/\bresponsive\b/g,/\bhelpful\b/g],
      [/\bunresponsive\b/g,/\bpoor support\b/g,/\bslow support\b/g,/\bno response\b/g]
    ),
    automation: evidenceDimensionScore(
      evidence,
      [/\bautomation\b/g,/\bautomate\w*\b/g,/\bworkflow\b/g,/\bintegration\b/g,/\bagent\b/g,/\bapi\b/g],
      [/\bmanual\b/g,/\bmanually\b/g,/\bno automation\b/g,/\blimited automation\b/g]
    ),
    accuracy: evidenceDimensionScore(
      evidence,
      [/\baccurate\b/g,/\baccuracy\b/g,/\bhigh quality\b/g,/\bquality output\b/g,/\breliable\b/g,/\bconsistent\b/g,/\bhuman[- ]like\b/g],
      [/\binaccurate\b/g,/\berror\w*\b/g,/\bincorrect\b/g,/\bpoor quality\b/g,/\binconsistent\b/g]
    )
  };

  /* Let concrete product evidence nudge dimensions without replacing it. */
  if(safeArray(product?.features).length >= 8) dimensions.features = Math.max(dimensions.features,8);
  if(safeArray(product?.platforms).length >= 3) dimensions.features = Math.max(dimensions.features,7);
  if(product?.trial === true) dimensions.pricing = Math.max(dimensions.pricing,6);
  if(product?.refund === true) dimensions.pricing = Math.max(dimensions.pricing,6);

  return dimensions;
}

function buildReviewScore({html, product, pros, cons, isReview, reviewData = {}}){
  if(!isReview){
    return {score:0,ratingValue:"0.0",reviewScore:{},breakdown:{}};
  }

  const categories = [
    ["features","Features"],
    ["easeOfUse","Ease of Use"],
    ["pricing","Pricing"],
    ["support","Support"],
    ["automation","Automation"],
    ["accuracy","Accuracy"]
  ];

  const reviewScore = {};
  const scoreSource = {};
  const derived = deriveReviewDimensions({html,product,pros,cons});
  const configuredScores = reviewData?.scores || {};

  categories.forEach(([key,label])=>{
    const explicit = extractScoreFromContent(html,label);
    if(explicit !== null){
      reviewScore[key] = explicit;
      scoreSource[key] = "review-content-explicit";
      return;
    }

    const configured = Number(configuredScores[key]);
    if(Number.isFinite(configured) && configured >= 0 && configured <= 10){
      reviewScore[key] = configured;
      scoreSource[key] = "legacy-enrichment";
      return;
    }

    reviewScore[key] = derived[key];
    scoreSource[key] = "review-content-evidence";
  });

  const values = categories.map(([key])=>Number(reviewScore[key])).filter(Number.isFinite);
  const finalScore = values.reduce((a,b)=>a+b,0) / values.length;
  const score100 = Math.round(finalScore * 10);

  return {
    score: score100,
    ratingValue: (score100 / 20).toFixed(1),
    reviewScore,
    breakdown:{
      features:reviewScore.features,
      easeOfUse:reviewScore.easeOfUse,
      pricing:reviewScore.pricing,
      support:reviewScore.support,
      automation:reviewScore.automation,
      accuracy:reviewScore.accuracy,
      dimensionsScored:values.length,
      dimensionsTotal:categories.length,
      scoreSource,
      prosCount:pros.length,
      consCount:cons.length,
      scoreMethod:"canonical-content-evidence"
    }
  };
}

/* =========================================================
   REVIEW TIMELINE
   ========================================================= */

function generateReviewTimeline(post){
  if(!post.isReview) return "";

  const review = getReviewData(post.product?.slug);
  const history = getVersionHistory(post.product?.slug);

  const updated =
    post.product?.lastUpdated ||
    history.at(-1)?.date ||
    post.date ||
    "Not specified";

  const version =
    post.product?.version ||
    history.at(-1)?.version ||
    "Not specified";

  const duration =
    post.product?.inferredTestDuration ||
    review.testDuration ||
    "Not specified";

  const platforms =
    safeArray(post.product?.platforms).length
      ? safeArray(post.product?.platforms)
      : safeArray(review.platforms);

  const reviewedBy =
    post.product?.reviewedBy ||
    review.reviewedBy ||
    "Justin Gerald";

  return `
  <section class="review-timeline">
    <h2>Review Timeline</h2>

    <div class="timeline-grid">
      <div>
        <strong>Updated</strong>
        <span>${escapeHtml(updated)}</span>
      </div>

      <div>
        <strong>Product Version</strong>
        <span>${escapeHtml(version)}</span>
      </div>

      <div>
        <strong>Test Duration</strong>
        <span>${escapeHtml(duration)}</span>
      </div>

      <div>
        <strong>Platform</strong>
        <span>
          ${
            platforms.length
              ? platforms.map(escapeHtml).join(" • ")
              : "Not specified"
          }
        </span>
      </div>

      <div>
        <strong>Reviewed by</strong>
        <span>${escapeHtml(
          getAuthorData(review.reviewedBy)?.name ||
          escapeHtml(reviewedBy) ||
          "Justin Gerald"
        )}</span>
      </div>
    </div>
  </section>
  `;
}

/* =========================================================
   TESTING METHODOLOGY
   ========================================================= */

function generateTestingMethodology(post){
  if(!post.isReview) return "";

  const review = getReviewData(post.product?.slug);

  const methodology =
    safeArray(review.methodology).length
      ? review.methodology
      : [
          "Installation",
          "Setup",
          "Speed",
          "Output Quality",
          "Customer Support",
          "Pricing",
          "Refund",
          "Updates",
          "Competition",
          "Overall Score"
        ];

  return `
  <section class="testing-methodology">
    <h2>How We Tested</h2>
    <ul>
      ${methodology.map(item =>
        `<li>✓ ${escapeHtml(item)}</li>`
      ).join("")}
    </ul>
  </section>
  `;
}

/* =========================================================
   VERDICT ENGINE
   ========================================================= */

function generateVerdictBox(post){
  if(!post.isReview) return "";

  const product = post.product || {};

  const bestFor = safeArray(product.bestFor);

  const avoid = safeArray(product.avoidFor);

  return `
  <section class="verdict-box review-verdict-box">
    <h2>The Verdict</h2>

    <div class="verdict-columns">

      <div>
        <h3>Who should buy this?</h3>
        <ul>
          ${
            bestFor.length
              ? bestFor.map(x=>`<li>✔ ${escapeHtml(x)}</li>`).join("")
              : `<li>✔ See the verified audience profile below.</li>`
          }
        </ul>
      </div>

      <div>
        <h3>Who should avoid it?</h3>
        <ul>
          ${avoid.length ? avoid.map(x=>`<li>✘ ${escapeHtml(x)}</li>`).join("") : `<li>✘ No verified avoid profile supplied yet.</li>`}
        </ul>
      </div>

    </div>
  </section>
  `;
}

function generateRotatingRelatedGuides(currentPost, allPosts) {

  const currentUrl = currentPost?.url || "";

  const candidates = safeArray(allPosts)
    .filter(p => p.url && p.url !== currentUrl)
    .filter(p => !p.isReview);

  if (!candidates.length) {
    return `
      <div class="sidebar-card">
        <h3>📚 Related Guides</h3>
        <p>No supporting guides available yet.</p>
      </div>
    `;
  }

  const currentCategory =
    String(currentPost?.category || "").toLowerCase();

  const currentKeywords = [
    ...safeArray(currentPost?.product?.keywords),
    ...safeArray(currentPost?.tags),
    currentCategory
  ]
    .map(x => String(x).toLowerCase())
    .filter(Boolean);

  function relevanceScore(post) {

    const text = [
      post.title,
      post.description,
      post.category,
      ...safeArray(post.tags),
      ...safeArray(post.product?.keywords)
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;

    currentKeywords.forEach(keyword => {
      if (keyword && text.includes(keyword)) {
        score += 3;
      }
    });

    if (
      String(post.category || "").toLowerCase() ===
      currentCategory
    ) {
      score += 8;
    }

    return score;
  }

  const ranked = candidates
    .map(post => ({
      post,
      score: relevanceScore(post)
    }))
    .sort((a,b) => b.score - a.score);

  /*
     Rotation:
     Each build starts from a different point in the
     supporting-post pool instead of always showing
     the exact same three articles.
  */

  const seed = Array.from(currentUrl).reduce(
    (total,ch) => total + ch.charCodeAt(0),
    0
  );

  const rotation =
    Math.abs(seed) % Math.max(ranked.length, 1);

  const rotated = [
    ...ranked.slice(rotation),
    ...ranked.slice(0,rotation)
  ];

  const selected = rotated
    .slice(0, 3)
    .map(x => x.post);

  return `
    <div class="sidebar-card related-guides-widget">

      <h3>📚 Related Guides</h3>

      <ul>
        ${selected.map(post => `
          <li>
            <a href="${post.url}">
              ${escapeHtml(post.title)}
            </a>
          </li>
        `).join("")}
      </ul>

    </div>
  `;
}

/* =========================================================
   AUTOMATIC ALTERNATIVES
   ========================================================= */

function calculateProductSimilarity(a,b){
  if(!a || !b) return 0;

  const set = value => new Set(safeArray(value).map(normalizeText).filter(Boolean));
  const overlap = (x,y) => {
    const aSet=set(x), bSet=set(y);
    if(!aSet.size || !bSet.size) return 0;
    let hits=0;
    bSet.forEach(v=>{ if(aSet.has(v)) hits++; });
    return Math.min(1,hits/Math.max(1,Math.min(aSet.size,bSet.size)));
  };

  let score = 0;
  if(a.category && b.category && a.category === b.category) score += 30;
  score += Math.round(overlap(a.keywords,b.keywords) * 20);
  score += Math.round(overlap(a.bestFor,b.bestFor) * 10);
  score += Math.round(overlap(a.useCases,b.useCases) * 15);
  score += Math.round(overlap(a.audience,b.audience) * 10);
  score += Math.round(overlap(a.features,b.features) * 10);
  if(a.pricingModel && b.pricingModel && a.pricingModel === b.pricingModel) score += 5;

  return Math.min(100,score);
}

function generateAutomaticAlternatives(post, allPosts){
  if(!post.isReview) return "";

  const candidates = allPosts
    .filter(p => p.slug !== post.slug && p.isReview && p.product)
    .map(p=>({
      post:p,
      similarity:calculateProductSimilarity(post.product,p.product)
    }));

  if(!candidates.length) return "";

  const priceOf = item => {
    const n = parseFloat(String(item.post.product?.price || "").replace(/[^0-9.]/g,""));
    return Number.isFinite(n) ? n : Infinity;
  };

  const scoreOf = item => Number(item.post.score?.score || 0);
  const easeOf = item => Number(item.post.reviewScore?.easeOfUse || 0);
  const featureOf = item => Number(item.post.reviewScore?.features || 0);
  const premiumOf = item => Number(item.post.product?.price || "").replace(/[^0-9.]/g,"") || 0;

  const roles = [
    ["Best Alternative", arr => [...arr].sort((a,b)=>b.similarity-a.similarity)[0]],
    ["Cheapest Alternative", arr => [...arr].sort((a,b)=>priceOf(a)-priceOf(b))[0]],
    ["Best Beginner Tool", arr => [...arr].sort((a,b)=>(easeOf(b)+scoreOf(b))-(easeOf(a)+scoreOf(a)))[0]],
    ["Fastest Tool", arr => [...arr].sort((a,b)=>easeOf(b)-easeOf(a))[0]],
    ["Best Value", arr => [...arr].sort((a,b)=>scoreOf(b)-scoreOf(a))[0]],
    ["Best Premium", arr => [...arr].sort((a,b)=>premiumOf(b)-premiumOf(a))[0]]
  ];

  return `
  <section class="automatic-alternatives">
    <h2>Best Alternatives</h2>
    <div class="alternative-grid">
      ${roles.map(([role,pick])=>{
        const item = pick(candidates) || candidates[0];
        return `
        <div class="alternative-card">
          <strong>${role}</strong>
          <a href="${item.post.url}">${escapeHtml(item.post.title)}</a>
          <span>${item.similarity}% similarity</span>
        </div>`;
      }).join("")}
    </div>
  </section>`;
}

/* =========================================================
   BUYING GUIDE
   ========================================================= */

function generateBuyingGuide(post){
  if(!post.isReview) return "";

  const categoryName =
    formatCategoryTitle(post.category || "AI tools");

  return `
  <section class="buying-guide">
    <h2>Buying Guide</h2>

    <h3>How to choose</h3>
    <p>
      Compare the tool's actual workflow, output quality, pricing,
      support, integrations and suitability for your intended use.
    </p>

    <h3>Common mistakes</h3>
    <p>
      Do not choose software based only on feature counts, promotional
      claims or the lowest headline price.
    </p>

    <h3>Who needs it?</h3>
    <p>
      ${escapeHtml(categoryName)} buyers should focus on whether the
      workflow solves their actual recurring problem.
    </p>

    <h3>Pricing explained</h3>
    <p>
      Check the current pricing model, included limits, upgrade tiers
      and recurring costs before purchasing.
    </p>

    <h3>Refund explained</h3>
    <p>
      Review the current refund terms before purchasing because policies
      can differ between products and plans.
    </p>

    <h3>Alternatives</h3>
    <p>
      Review the alternatives shown on this page before making a final
      decision.
    </p>
  </section>
  `;
}

/* =========================================================
   ENTITY ENGINE
   ========================================================= */

function detectEntities(text){
  const normalized = safeLower(text);

  return getEntityData()
    .filter(entity =>
      normalized.includes(safeLower(entity.name))
    )
    .map(entity=>entity.name);
}

function generateEntitySchema(post){
  const names = [...new Set([
    ...detectEntities(`${post.title} ${post.description} ${post.html}`),
    ...safeArray(post.entities),
    post.product?.name,
    post.product?.brand,
    post.product?.developer
  ].filter(Boolean))];

  if(!names.length) return null;

  return {
    "@context":"https://schema.org",
    "@type":"ItemList",
    "name":"Related AI entities",
    "itemListElement":names.map((name,index)=>({
      "@type":"ListItem",
      "position":index+1,
      "name":name
    }))
  };
}

/* =========================================================
   CHANGE LOG
   ========================================================= */

function generateReviewHistory(post){
  if(!post.isReview) return "";

  const history = getVersionHistory(post.product?.slug);

  if(!history.length){
    return `
    <section class="review-history">
      <h2>Review History</h2>
      <p>No verified change-log entries have been recorded for this product yet.</p>
    </section>`;
  }

  return `
  <section class="review-history">
    <h2>Review History</h2>

    ${history.map(item=>`
      <div class="history-item">
        <strong>${escapeHtml(item.date || "")}</strong>

        ${
          item.version
            ? `<span>Version ${escapeHtml(item.version)}</span>`
            : ""
        }

        <ul>
          ${safeArray(item.changes)
            .map(change=>`<li>${escapeHtml(change)}</li>`)
            .join("")}
        </ul>
      </div>
    `).join("")}
  </section>
  `;
}

/* =========================================================
   TRUST SIGNALS
   ========================================================= */

function generateSiteTrustSignals(){
  return `
  <section class="site-trust-signals">
    <div>✓ Independent Reviews</div>
    <div>✓ No Sponsored Rankings</div>
    <div>✓ Hands-on Testing</div>
    <div>✓ Updated Regularly</div>
    <div>✓ Transparent Methodology</div>
  </section>
  `;
}

/* =========================================================
   DYNAMIC SIDEBAR WIDGETS
   ========================================================= */

function getWidgetProducts(posts){
  const reviews = posts.filter(p=>p.isReview && p.product);

  return {
    highestRated: [...reviews]
      .sort((a,b)=>
        Number(b.product.rating || 0) -
        Number(a.product.rating || 0)
      ).slice(0,5),

    recentlyUpdated: [...reviews]
      .sort((a,b)=>
        new Date(b.product.lastUpdated || b.date) -
        new Date(a.product.lastUpdated || a.date)
      ).slice(0,5),

    trending: reviews.slice(0,5),

    mostCompared: reviews
      .sort((a,b)=>
        ((generatedComparisons.get(b.slug)||[]).length) -
        ((generatedComparisons.get(a.slug)||[]).length)
      ).slice(0,5),

    bestValue: [...reviews]
      .sort((a,b)=>
        Number(b.score?.score || 0) -
        Number(a.score?.score || 0)
      ).slice(0,5),

    mostPopular: reviews.slice(0,5)
  };
}

function generateDynamicSidebar(posts){
  const widgets = getWidgetProducts(posts);

  const sections = [
    ["Highest Rated",widgets.highestRated],
    ["Recently Updated",widgets.recentlyUpdated],
    ["Trending",widgets.trending],
    ["Most Compared",widgets.mostCompared],
    ["Best Value",widgets.bestValue],
    ["Most Popular",widgets.mostPopular]
  ];

  return sections.map(([title,items])=>`
    <div class="sidebar-card dynamic-widget">
      <h3>${title}</h3>
      <ul>
        ${items.map(item=>`
          <li>
            <a href="${item.url}">
              ${escapeHtml(item.title)}
            </a>
          </li>
        `).join("")}
      </ul>
    </div>
  `).join("");
}

/* =========================================================
   RADAR SVG
   ========================================================= */

function generateRadarChart(post){
  if(!post.isReview) return "";

  const values = post.score?.reviewScore || {};
  const reviewText = cleanText(post.html || "").toLowerCase();
  const product = post.product || {};

  const evidenceScore = (patterns, base = 5) => {
    let value = base;
    patterns.forEach(([pattern,delta])=>{
      if(pattern.test(reviewText)) value += delta;
    });
    return Math.max(1,Math.min(10,value));
  };

  const fallbacks = {
    easeOfUse: evidenceScore([[/\beasy\b|\bsimple\b|\bintuitive\b|\bbeginner\b/i,1],[/\bconfusing\b|\bdifficult\b|\bcomplex\b/i,-1]]),
    accuracy: evidenceScore([[/\baccurate\b|\baccuracy\b|\bprecise\b|\bnatural\b|\bquality\b/i,1],[/\binaccurate\b|\berror\b|\berrors\b/i,-1]]),
    automation: evidenceScore([[/\bautomati(?:on|c)\b|\bworkflow\b|\bintegration\b|\bagent\b/i,1],[/\bmanual\b|\bmanually\b/i,-1]]),
    features: Math.max(1,Math.min(10,5 + Math.min(3,safeArray(product.features).length))),
    support: evidenceScore([[/\bsupport\b|\bcustomer service\b|\bhelp center\b/i,1],[/\bunresponsive\b|\bpoor support\b/i,-1]]),
    pricing: evidenceScore([[/\baffordable\b|\bgood value\b|\bworth the price\b|\bvalue\b/i,1],[/\bexpensive\b|\boverpriced\b|\bcostly\b/i,-1]])
  };

  const getRadarValue = key => {
    const value = Number(values[key]);
    if(Number.isFinite(value) && value > 0) return Math.max(0,Math.min(10,value));
    return fallbacks[key] ?? 5;
  };

  const axes = [
    ["Speed",getRadarValue("easeOfUse")],
    ["Accuracy",getRadarValue("accuracy")],
    ["Automation",getRadarValue("automation")],
    ["Templates",getRadarValue("features")],
    ["Support",getRadarValue("support")],
    ["Pricing",getRadarValue("pricing")]
  ];

  const cx = 150;
  const cy = 150;
  const radius = 100;

  const pointFor = (angle,r) => [
    cx + Math.cos(angle) * r,
    cy + Math.sin(angle) * r
  ];

  const points = axes.map((axis,index)=>{
    const angle = (-Math.PI / 2) +
      (index * Math.PI * 2 / axes.length);
    return pointFor(angle, radius * axis[1] / 10);
  });

  const polygon = points
    .map(([x,y])=>`${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");

  const rings = [1,0.75,0.5,0.25].map(scale=>{
    const ringPoints = axes.map((axis,index)=>{
      const angle = (-Math.PI / 2) +
        (index * Math.PI * 2 / axes.length);
      const [x,y] = pointFor(angle, radius * scale);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    return `<polygon points="${ringPoints}" fill="none" stroke="#475569" stroke-width="1" opacity=".65" />`;
  }).join("");

  const spokes = axes.map((axis,index)=>{
    const angle = (-Math.PI / 2) +
      (index * Math.PI * 2 / axes.length);

    const [x,y] = pointFor(angle, radius);
    const labelRadius = radius + 24;
    const [tx,ty] = pointFor(angle,labelRadius);

    return `
      <line
        x1="${cx}"
        y1="${cy}"
        x2="${x.toFixed(1)}"
        y2="${y.toFixed(1)}"
        stroke="#64748b"
        stroke-width="1"
      />
      <text
        x="${tx.toFixed(1)}"
        y="${ty.toFixed(1)}"
        text-anchor="middle"
        dominant-baseline="middle"
        font-size="10"
      >${escapeHtml(axis[0])}</text>
    `;
  }).join("");

  return `
  <section class="review-radar">
    <h2>Performance Profile</h2>

    <svg viewBox="0 0 300 300"
         role="img"
         aria-label="Review performance radar chart">

      ${rings}

      <polygon
        points="${polygon}"
        fill="rgba(37,99,235,.18)"
        stroke="#60a5fa"
        stroke-width="2"
      />

      ${spokes}

    </svg>
  </section>
  `;
}

const FEED_URL =
"https://honestproductreviewlab.blogspot.com/feeds/posts/default?alt=atom";

import site from "./_data/site.json" with { type: "json" };

function loadJson(filePath, fallback){
  try{
    if(!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath,"utf-8"));
  }catch(error){
    console.warn("⚠ Could not load",filePath,"— using fallback.");
    return fallback;
  }
}

/*
  These JSON files are optional enrichment/fallback data.
  Blogger remains the active content source, and generated
  snapshots are rebuilt later from the current feed.
*/
let products = loadJson("./_data/products.json", []);
let entities = loadJson("./_data/entities.json", []);
let comparisonsData = loadJson("./_data/comparisons.json", []);
let authors = loadJson("./_data/authors.json", []);
let faqData = loadJson("./_data/faq.json", []);
let reviewsData = loadJson("./_data/reviews.json", []);
let glossary = loadJson("./_data/glossary.json", []);
let versions = loadJson("./_data/versions.json", []);

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
.filter(post =>
  post.slug !== currentPost.slug &&
  post.isReview === true
)
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
  html,
  productMatch,
  isReview,
  pros,
  cons,
  reviewData = {}
}){

  return buildReviewScore({
    html,
    product: productMatch,
    pros,
    cons,
    isReview,
    reviewData
  });
}

const seenSlugs = new Set();

const posts=[];

function inferProductDataFromPost(title, html, category, pros = [], cons = [], labels = []){
  const plain = cleanText(html);
  const metadata = extractReviewMetadata(title, html, labels, category);

  const normalizedTitle = safeString(title)
    .replace(/\b(honest|in-depth|deep|complete|ultimate|2024|2025|2026|review|product review)\b/gi," ")
    .replace(/[-–—|:()[\]{}]/g," ")
    .replace(/\s+/g," ")
    .trim();

  const name = metadata.productName || normalizedTitle || title;
  const priceMatch = metadata.price || ((plain.match(/(?:[$€£₦]\s*)[0-9][0-9,]*(?:\.[0-9]{1,2})?(?:\s*\/\s*(?:month|mo|year|yr|week|one[- ]time))?/i) || [""])[0]);

  const keywordSet = new Set();
  [title, name, metadata.category || category, plain].join(" ").toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 4)
    .slice(0,180)
    .forEach(word => keywordSet.add(word));

  const slug = safeString(name).toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-|-$/g,"") || safeString(title).toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-|-$/g,"");

  return {
    slug,
    name,
    brand: name,
    developer: "",
    category: metadata.category || category || "ai-writing-tools",
    website: metadata.website || "",
    price: priceMatch || "",
    pricingModel: /one[- ]time/i.test(priceMatch) ? "One-time" : (/\/\s*(month|mo|year|yr|week)/i.test(priceMatch) ? "Subscription" : ""),
    trial: metadata.trial,
    refund: metadata.refund,
    rating: 0,
    reviewed: true,
    featured: false,
    affiliate: "",
    pros: safeArray(pros),
    cons: safeArray(cons),
    bestFor: [],
    avoidFor: [],
    alternative: [],
    features: [],
    keywords: [...keywordSet].slice(0,40),
    audience: [],
    useCases: [],
    strengths: [],
    lastUpdated: "",
    version: metadata.version || "",
    platforms: metadata.platforms,
    performance: {},
    reviewScore: {},
    inferredTestDuration: metadata.testDuration || "",
    reviewedBy: metadata.reviewedBy || "Justin Gerald"
  };
}

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

    return variations.some(v =>
      normalizedSearch.includes(v)
    );
  });

  if (!product) return null;

  return {
    slug: product.slug || "",
    name: product.name || "",
    brand: product.brand || product.name || "",
    developer: product.developer || "",

    category: product.category || "",
    website: product.website || "",

    price: product.price || "",
    pricingModel: product.pricingModel || "",

    trial: product.trial ?? false,
    refund: product.refund ?? false,

    rating: Number(product.rating || 0),

    reviewed: product.reviewed ?? true,
    featured: product.featured ?? false,

    affiliate: product.affiliate || "",

    pros: safeArray(product.pros),
    cons: safeArray(product.cons),
    bestFor: safeArray(product.bestFor),

    alternative: safeArray(product.alternative),
    features: safeArray(product.features),
    keywords: safeArray(product.keywords),

    audience: safeArray(product.audience),
    useCases: safeArray(product.useCases),
    strengths: safeArray(product.strengths),

    lastUpdated: product.lastUpdated || "",
    version: product.version || "",

    platforms: safeArray(product.platforms),

    performance: product.performance || {},
    reviewScore: product.reviewScore || {},
    avoidFor: safeArray(product.avoidFor),
    audience: safeArray(product.audience),
    useCases: safeArray(product.useCases),
    strengths: safeArray(product.strengths)
  };
}

function detectTopic(title, html) {
  // 1. First try the products database
  const product = getProductData(title, html);

  if (product?.category) {
    return product.category;
  }

  // 2. Fallback to keyword detection
  const content = safeLower(`${title} ${html}`);
  const weights = {
    "ai-writing-tools": [
      "writer","writing","copy","copywriting","blog",
      "content","article","seo","chatgpt","claude","jasper"
    ],

    "ai-image-generators": [
      "image","images","art","logo","photo",
      "midjourney","flux","stable diffusion","dalle","design"
    ],

    "ai-voice-tools": [
      "voice","speech","audio","tts","voice clone","voice cloning",
      "text to speech","elevenlabs","soundsoreal","podcast"],

    "automation-tools": [
      "automation","workflow","zapier","make","n8n","integration",
      "agent","agents","ai agent"]
  };

  let best = "ai-writing-tools";
  let highest = 0;

  for (const [category, words] of Object.entries(weights)) {
    let score = 0;

    words.forEach(word => {
      const regex = new RegExp(
        word.replace(/\s+/g,"\\s+"),
        "gi"
      );
      score += (content.match(regex) || []).length;
    });

    if(score > highest){
      highest = score;
      best = category;
    }
  }
  return best;
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
  
/* SAFE LABEL EXTRACTION — NORMALIZED */
let labels = [];

const categories = safeArray(entry.category);

labels = categories
  .map(c => safeLower(c?.term))
  .map(label =>
    label
      .replace(/[_]+/g, " ")
      .replace(/[-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
  .filter(Boolean);
  
/* NEW AI-DRIVEN CATEGORY ENGINE */
const extractedMetadata = extractReviewMetadata(title, rawHtml, labels, "");
let category = extractedMetadata.category || detectTopic(title, rawHtml); 

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
/* SCHEMA */
const wordCount = textOnly.split(/\s+/).length;
let productMatch = getProductData(title, rawHtml);
let productInfo = productMatch || {};
const structuredProsCons =
  extractStructuredProsCons(rawHtml, productInfo);

const pros = structuredProsCons.pros;
const cons = structuredProsCons.cons;
const lowerTitle = title.toLowerCase();
/* POST TYPE — EXPLICIT AND FUTURE-PROOF
   The Blogger label is the authoritative source.

   Supported labels:
   - review
   - supporting
   - support

   If "review" exists, the post is a main review.
   If "supporting" or "support" exists, it is a supporting article.

   We intentionally do NOT infer review status from the title.
   This prevents future supporting articles containing words such as
   "better", "results", "rating", "working", etc. from being treated
   as reviews.
*/
/* POST TYPE — NORMALIZED BLOGGER LABEL AUTHORITY */
const normalizedLabels = labels.map(label =>
  safeLower(label)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
);

const hasReviewLabel =
  normalizedLabels.includes("review") ||
  normalizedLabels.includes("main review");

const hasSupportingLabel =
  normalizedLabels.includes("supporting") ||
  normalizedLabels.includes("support") ||
  normalizedLabels.includes("supporting article");

let isReview = false;

if (hasReviewLabel) {
  isReview = true;
} else if (hasSupportingLabel) {
  isReview = false;
} else {
  /*
    Backward-compatible fallback for older posts that do not yet
    have an explicit post-type label.

    Only strong review signals are allowed here.
    Generic words such as "better", "results", or "working" are
    deliberately excluded.
  */
  isReview =
    lowerTitle.includes("review") ||
    lowerTitle.includes("verdict") ||
    lowerTitle.includes("rating");
}
const postType = isReview ? "review" : "supporting";

if(isReview && !productMatch){
  productInfo = inferProductDataFromPost(
    title,
    rawHtml,
    category,
    pros,
    cons,
    labels
  );
  productInfo.lastUpdated = productInfo.lastUpdated || entry.published || "";
  productInfo.category = productInfo.category || category || "ai-writing-tools";
  productInfo.slug = productInfo.slug || slug;
  productMatch = productInfo;
}

if(isReview && productMatch){
  /* Blogger content is authoritative for metadata found in the post. */
  productMatch.slug = extractedMetadata.productName
    ? safeString(extractedMetadata.productName).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")
    : (productMatch.slug || slug);
  productMatch.name = extractedMetadata.productName || productMatch.name || title;
  productMatch.category = extractedMetadata.category || productMatch.category || category || "ai-writing-tools";
  productMatch.website = extractedMetadata.website || productMatch.website || "";
  productMatch.price = extractedMetadata.price || productMatch.price || "";
  productMatch.version = extractedMetadata.version || productMatch.version || "";
  productMatch.platforms = extractedMetadata.platforms.length ? extractedMetadata.platforms : safeArray(productMatch.platforms);
  productMatch.trial = extractedMetadata.trial || productMatch.trial || false;
  productMatch.refund = extractedMetadata.refund || productMatch.refund || false;
  productMatch.inferredTestDuration = extractedMetadata.testDuration || productMatch.inferredTestDuration || "";
  productMatch.reviewedBy = extractedMetadata.reviewedBy || productMatch.reviewedBy || "Justin Gerald";
  productMatch.lastUpdated = productMatch.lastUpdated || entry.published || "";
}

const reviewData = getReviewData(productInfo.slug);

const reviewScore = calculateReviewScore({
  html: rawHtml,
  pros,
  cons,
  productMatch,
  isReview,
  reviewData
});
const ratingValue = reviewScore.ratingValue;

/* 3. Safety Check - Corrected & Applied */
const brandName =
productInfo.brand ||
(title.includes(" ")
? title.split(" ")[0]
: title);

const reviewRatingSchema = reviewScore.score > 0
  ? {
      "@type":"Rating",
      "ratingValue":reviewScore.ratingValue,
      "bestRating":"5",
      "worstRating":"1"
    }
  : null;

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
  "brand":{
    "@type":"Brand",
    "name":productInfo.brand || brandName
  },
  "review":{
    "@type":"Review",
    "author":{"@type":"Person","name":"Justin Gerald"},
    "reviewBody": description,
    "positiveNotes": pros,
    "negativeNotes": cons,
    ...(reviewRatingSchema ? {"reviewRating":reviewRatingSchema} : {})
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

const entitySchema =
  generateEntitySchema({
    title,
    description,
    html: rawHtml
  });
  
posts.push({
  title,
  slug,
  html: rawHtml,
  url,
  description,
  og: primaryOG,
  thumb: primaryOG,
  readTime,
  date: entry.published,
  lastmod: new Date().toISOString(),
  category: category,
  product: productInfo,
  score: reviewScore,
  isReview: isReview,
  reviewScore: reviewScore.reviewScore || {},
reviewBreakdown: reviewScore.breakdown || {},
pros,
cons,
entities: [...new Set([
    ...detectEntities(`${title} ${rawHtml}`),
    productInfo.name,
    productInfo.brand,
    productInfo.developer
  ].filter(Boolean))],
reviewData: getReviewData(productInfo.slug),
versionHistory: getVersionHistory(productInfo.slug),
  postType: isReview ? "review" : "supporting",
  labels,
  schemas: JSON.stringify([
  ...(isReview
    ? [articleSchema, productSchema]
    : [articleSchema]
  ),
  ...(entitySchema ? [entitySchema] : [])
])
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

/* =========================================================
   AUTOMATIC BUILD DATA SNAPSHOTS
   Blogger is the active-post source of truth. Generated
   products/reviews/versions contain only active review posts.
   ========================================================= */

const activeReviews = posts.filter(p =>
  p.isReview &&
  p.product &&
  (p.product.slug || p.slug)
);

const generatedProducts = activeReviews.map(post => ({
  ...post.product,
  slug: post.product.slug || post.slug,
  name: post.product.name || post.title,
  category: post.product.category || post.category,
  pros: safeArray(post.pros),
  cons: safeArray(post.cons),
  lastUpdated: post.product.lastUpdated || post.date,
  reviewScore: post.score?.reviewScore || post.product.reviewScore || {},
  reviewedBy: post.product.reviewedBy || "Justin Gerald",
  testDuration: post.product.inferredTestDuration || "",
  version: post.product.version || "",
  platforms: safeArray(post.product.platforms)
}));

const generatedReviews = activeReviews.map(post => {
  const existing = getReviewData(post.product.slug) || {};

  return {
    ...existing,
    productSlug: post.product.slug || post.slug,
    testDuration:
      post.product.inferredTestDuration ||
      existing.testDuration ||
      "",
    platforms: safeArray(post.product.platforms).length
      ? safeArray(post.product.platforms)
      : safeArray(existing.platforms),
    methodology: safeArray(existing.methodology).length
      ? existing.methodology
      : [
          "Installation",
          "Setup",
          "Speed",
          "Output Quality",
          "Customer Support",
          "Pricing",
          "Refund",
          "Updates",
          "Competition",
          "Overall Score"
        ],
    reviewedBy: post.product.reviewedBy || existing.reviewedBy || "justin-gerald",
    scores: post.score?.reviewScore || existing.scores || {},
    scoreBreakdown: post.score?.breakdown || existing.scoreBreakdown || {}
  };
});

const generatedVersions = activeReviews.map(post => {
  const existing = getVersionHistory(post.product.slug);

  return {
    productSlug: post.product.slug || post.slug,
    history: existing.length
      ? existing
      : [{
          date: post.product.lastUpdated || post.date,
          version: post.product.version || "",
          changes: ["Initial ReviewLab review snapshot"]
        }]
  };
});

function extractFAQEntriesFromPost(post){
  const html = safeString(post.html);
  const entries = [];
  const regex = /<h[2-4][^>]*>\s*([^<]*\?)\s*<\/h[2-4]>([\s\S]*?)(?=<h[2-4][^>]*>|$)/gi;
  let match;
  while((match = regex.exec(html)) !== null){
    const answer = cleanText(match[2]).slice(0,600);
    if(answer){
      entries.push({
        question: cleanText(match[1]),
        answer,
        productSlug: post.product?.slug || post.slug,
        url: post.url
      });
    }
  }
  return entries.slice(0,8);
}

const generatedEntities = [...new Map(
  posts.flatMap(post => safeArray(post.entities).map(name => [safeLower(name), {
    name,
    type: "SoftwareApplication",
    mentions: posts.filter(p => safeArray(p.entities).some(e => safeLower(e) === safeLower(name))).map(p => p.slug)
  }])).filter(([key]) => key)
).values()];

const generatedAuthors = [...new Map(
  posts.filter(p => p.isReview).map(post => {
    const name = post.product?.reviewedBy || "Justin Gerald";
    const slug = safeLower(name).replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
    return [slug, {
      slug,
      name,
      role: "ReviewLab Reviewer",
      url: `${SITE_URL}/author/`
    }];
  })
)].map(([,value])=>value);

if(!generatedAuthors.length){
  generatedAuthors.push({slug:"justin-gerald",name:"Justin Gerald",role:"ReviewLab Reviewer",url:`${SITE_URL}/author/`});
}

const generatedFaq = posts.flatMap(extractFAQEntriesFromPost);

const glossaryTerms = [
  ["Artificial Intelligence","artificial intelligence"],
  ["Machine Learning","machine learning"],
  ["Prompt Engineering","prompt engineering"],
  ["Automation","automation"],
  ["LLM","llm"],
  ["Inference","inference"],
  ["API","api"],
  ["Token","token"],
  ["Embedding","embedding"],
  ["Fine Tuning","fine tuning|fine-tuning"]
];

const generatedGlossary = glossaryTerms.map(([name,pattern])=>{
  const regex = new RegExp(`[^.!?]{0,180}\\b(?:${pattern})\\b[^.!?]{0,280}[.!?]`,"i");
  const source = posts.find(post => regex.test(cleanText(post.html)));
  const definition = source
    ? (cleanText(source.html).match(regex)?.[0] || `This term appears in ReviewLab content about ${name}.`).trim()
    : `This term is part of the AI and technology topics covered by ReviewLab.`;
  return {
    name,
    slug: safeLower(name).replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""),
    definition,
    sourceUrl: source?.url || ""
  };
});

/* Canonical generated datasets replace manual enrichment as the build source of truth. */
products = generatedProducts;
reviewsData = generatedReviews;
versions = generatedVersions;
entities = generatedEntities;
authors = generatedAuthors;
faqData = generatedFaq;
glossary = generatedGlossary;

const generatedComparisonRecords = [];
const reviewOnly = posts.filter(p => p.isReview && p.product);
for(let i=0;i<reviewOnly.length;i++){
  for(let j=i+1;j<reviewOnly.length;j++){
    const a = reviewOnly[i];
    const b = reviewOnly[j];
    generatedComparisonRecords.push({
      slug: `${a.slug}-vs-${b.slug}`,
      title: `${a.product?.name || a.title} vs ${b.product?.name || b.title}`,
      products: [a.product?.slug || a.slug, b.product?.slug || b.slug],
      scores: {
        [a.product?.slug || a.slug]: a.score?.score || 0,
        [b.product?.slug || b.slug]: b.score?.score || 0
      },
      urls: [a.url,b.url]
    });
  }
}
comparisonsData = generatedComparisonRecords;

const reviewRotationData = activeReviews.map(post => ({
  title: post.title,
  url: post.url,
  slug: post.slug,
  category: post.category,
  score: Number(post.score?.score || 0)
}));

const supportingRotationData = posts
  .filter(p => !p.isReview)
  .map(post => ({
    title: post.title,
    url: post.url,
    slug: post.slug,
    category: post.category
  }));

fs.writeFileSync(
  "_site/_data/products.json",
  JSON.stringify(generatedProducts,null,2)
);

fs.writeFileSync(
  "_site/_data/reviews.json",
  JSON.stringify(generatedReviews,null,2)
);

fs.writeFileSync(
  "_site/_data/versions.json",
  JSON.stringify(generatedVersions,null,2)
);

fs.writeFileSync(
  "_site/assets/rotation.json",
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    reviews: reviewRotationData,
    supporting: supportingRotationData
  },null,2)
);

fs.writeFileSync("_site/_data/entities.json", JSON.stringify(generatedEntities,null,2));
fs.writeFileSync("_site/_data/comparisons.json", JSON.stringify(generatedComparisonRecords,null,2));
fs.writeFileSync("_site/_data/authors.json", JSON.stringify(generatedAuthors,null,2));
fs.writeFileSync("_site/_data/faq.json", JSON.stringify(generatedFaq,null,2));
fs.writeFileSync("_site/_data/glossary.json", JSON.stringify(generatedGlossary,null,2));

console.log("AUTO DATA: active reviews =", activeReviews.length);
console.log("AUTO DATA: products.json =", generatedProducts.length);
console.log("AUTO DATA: reviews.json =", generatedReviews.length);
console.log("AUTO DATA: versions.json =", generatedVersions.length);
console.log("AUTO DATA: supporting posts =", supportingRotationData.length);

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

  /*
    HARD SAFETY RULE:
    Trust/review block belongs ONLY to main review posts.
    Supporting articles must never receive this block.
  */
  if(!post || post.postType !== "review"){
    return "";
  }

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
if(
  !post ||
  post.postType !== "review" ||
  !post.product
){
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

function calculateComparisonScore(productA, productB){
let score = 0;
if(!productA || !productB)
return score;

/* Same category */
if(productA.category === productB.category)
score += 50;

/* Same developer */
if(
productA.developer &&
productB.developer &&
productA.developer === productB.developer
){
score += 30;
}

/* Same pricing */
if(
productA.pricingModel &&
productB.pricingModel &&
productA.pricingModel === productB.pricingModel
){
score += 15;
}

/* Same audience */
const bestForA = productA.bestFor || [];
const bestForB = productB.bestFor || [];
bestForA.forEach(item=>{
if(bestForB.includes(item)){
score += 12;
}
});

/* Similar ratings */
if(productA.rating && productB.rating){
const diff = Math.abs(productA.rating-productB.rating);
if(diff<=0.5)
score += 10;
}
return score;
}

/* AUTO COMPARISON ENGINE - UPDATED */
function generateComparison(postA, postB) {

  /*
    HARD SAFETY RULE:
    Comparison pages may only be generated from two main reviews.
  */
  if(
    !postA ||
    !postB ||
    postA.postType !== "review" ||
    postB.postType !== "review"
  ){
    return;
  }

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
        <th>${escapeHtml(postA.product?.name || postA.title)}</th>
        <th>${escapeHtml(postB.product?.name || postB.title)}</th>
      </tr>
    </thead>

    <tbody>

      <tr>
        <td>Speed</td>
        <td>${"★".repeat(Math.round(postA.reviewScore?.easeOfUse || 5))}</td>
        <td>${"★".repeat(Math.round(postB.reviewScore?.easeOfUse || 5))}</td>
      </tr>

      <tr>
        <td>AI Quality</td>
        <td>${"★".repeat(Math.round(postA.reviewScore?.accuracy || 5))}</td>
        <td>${"★".repeat(Math.round(postB.reviewScore?.accuracy || 5))}</td>
      </tr>

      <tr>
        <td>Templates</td>
        <td>${"★".repeat(Math.round(postA.reviewScore?.features || 5))}</td>
        <td>${"★".repeat(Math.round(postB.reviewScore?.features || 5))}</td>
      </tr>

      <tr>
        <td>Automation</td>
        <td>${"★".repeat(Math.round(postA.reviewScore?.automation || 5))}</td>
        <td>${"★".repeat(Math.round(postB.reviewScore?.automation || 5))}</td>
      </tr>

      <tr>
        <td>Support</td>
        <td>${"★".repeat(Math.round(postA.reviewScore?.support || 5))}</td>
        <td>${"★".repeat(Math.round(postB.reviewScore?.support || 5))}</td>
      </tr>

      <tr>
        <td>Pricing</td>
        <td>${"★".repeat(Math.round(postA.reviewScore?.pricing || 5))}</td>
        <td>${"★".repeat(Math.round(postB.reviewScore?.pricing || 5))}</td>
      </tr>

      <tr class="comparison-score-row">
        <td><strong>Overall Score</strong></td>
        <td><strong>${Number.isFinite(Number(postA.score?.score)) && Number(postA.score?.score) > 0 ? Number(postA.score.score) : Math.round((Object.values(postA.reviewScore || {}).reduce((a,b)=>a+Number(b||0),0) / Math.max(1,Object.values(postA.reviewScore || {}).length))*10)}/100</strong></td>
        <td><strong>${Number.isFinite(Number(postB.score?.score)) && Number(postB.score?.score) > 0 ? Number(postB.score.score) : Math.round((Object.values(postB.reviewScore || {}).reduce((a,b)=>a+Number(b||0),0) / Math.max(1,Object.values(postB.reviewScore || {}).length))*10)}/100</strong></td>
      </tr>

      <tr>
        <td>Review</td>
        <td><a href="${postA.url}">Read Review →</a></td>
        <td><a href="${postB.url}">Read Review →</a></td>
      </tr>

    </tbody>
  </table>
</div>

${generateRadarChart(postA)}
${generateRadarChart(postB)}

    <section class="verdict-box">
        <h2>The Verdict</h2>
        <p>
Compare the strengths, limitations, pricing, and intended use cases of
<strong>${postA.title}</strong> and
<strong>${postB.title}</strong>
to determine which option better matches your specific needs.
</p>
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

.filter(p => {
  return (
    p.slug !== postA.slug &&
    postA.postType === "review" &&
    p.postType === "review" &&
    postA.product &&
    p.product
  );
})

.map(p=>({
post:p,
score:calculateComparisonScore(
postA.product,
p.product
)
}))
.sort((a,b)=>b.score-a.score)
.slice(0,3)
.map(x=>x.post);
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
  if (posts[i].postType !== "review") continue;
  for(let j=i+1;j<posts.length && j<i+4;j++){
    if (posts[j].postType !== "review") continue;
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
/* =========================================================
   SITE-WIDE RECOMMENDATION ENGINE
   ========================================================= */

const reviewPool = posts.filter(
  p => p.isReview && p.product
);

function recommendationScore(post){

  const reviewScore =
    Number(post.score?.score || 0);

  const rating =
    Number(post.product?.rating || 0) * 10;

  const freshnessDate =
    new Date(
      post.product?.lastUpdated ||
      post.date ||
      0
    ).getTime();

  const ageDays =
    freshnessDate
      ? Math.max(
          0,
          (Date.now() - freshnessDate) /
          86400000
        )
      : 365;

  const freshness =
    Math.max(
      0,
      20 - Math.min(ageDays / 30,20)
    );

  /*
    Performance fields are optional.
    When the external dashboard eventually supplies them,
    they automatically participate without changing this engine.
  */
  const performance =
    post.product?.performance || {};

  const clicks =
    Number(performance.clicks || 0);

  const conversions =
    Number(performance.conversions || 0);

  const epc =
    Number(performance.epc || 0);

  const conversionScore =
    Math.min(20,conversions * 2);

  const clickScore =
    Math.min(10,clicks / 10);

  const epcScore =
    Math.min(10,epc);

  return (
    reviewScore * 0.40 +
    rating * 0.15 +
    freshness * 0.15 +
    clickScore * 0.10 +
    conversionScore * 0.10 +
    epcScore * 0.10
  );
}

const rankedRecommendations =
  [...reviewPool]
    .map(post=>({
      post,
      recommendationScore:
        recommendationScore(post)
    }))
    .sort(
      (a,b)=>
        b.recommendationScore -
        a.recommendationScore
    );

const topPosts =
  rankedRecommendations
    .slice(0,10)
    .map(item=>({
      title:item.post.title,
      url:item.post.url,
      score:item.post.score?.score || 0,
      recommendationScore:
        Number(
          item.recommendationScore.toFixed(2)
        )
    }));

const ctaJson =
  JSON.stringify(topPosts);

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

const supportingCandidates = posts
  .filter(p => !p.isReview && p.slug !== post.slug);

const supportingSeed = Array.from(post.url || "")
  .reduce((total,ch)=>total + ch.charCodeAt(0),0);

const rotatedSupporting = supportingCandidates.length
  ? [
      ...supportingCandidates.slice(
        supportingSeed % supportingCandidates.length
      ),
      ...supportingCandidates.slice(
        0,
        supportingSeed % supportingCandidates.length
      )
    ]
  : [];

let inlinePosts = rotatedSupporting.slice(0,3);

if(inlinePosts.length < 3){
  const extra = posts
    .filter(p => p.slug !== post.slug && !inlinePosts.some(x=>x.slug===p.slug))
    .slice(0,3-inlinePosts.length);
  inlinePosts = [...inlinePosts,...extra];
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
<div class="top-cta review-cta">
  <p><strong>🚀 Want the exact AI tool that’s making people money right now?</strong></p>
  <a href="javascript:void(0)" class="cta-btn">See #1 Tool →</a>
</div>
<p class="sub">
By <a href="${SITE_URL}/author/" rel="author">Justin Gerald</a> • ${post.readTime} min read
</p>
${post.isReview ? generateTrustBlock(post) : ""}
${post.isReview ? generateProductBox(post) : ""}
${post.isReview ? generateReviewTimeline(post) : ""}
${post.isReview ? generateTestingMethodology(post) : ""}
${post.isReview ? generateRadarChart(post) : ""}

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
${post.isReview ? generateBuyingGuide(post) : ""}

<section class="mid-cta review-cta">
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

${post.isReview ? generateVerdictBox(post) : ""}

${post.postType === "review" ? `
<section class="comparison-block review-cta-block">
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

${post.isReview ? generateAutomaticAlternatives(post, posts) : ""}
${post.isReview ? generateReviewHistory(post) : ""}

<section class="internal-widget">
<h3>Continue Reading</h3>
<ul class="internal-list">
${inlineRecs}
</ul>
</section>
<section class="money-cta review-cta">
<h3>Recommended AI Tool</h3>

<p>
Based on ReviewLab's current scoring and recommendation model.
</p>

<a
  href="${topPosts[0]?.url || SITE_URL + "/ai-tools/"}"
  class="cta-btn"
>
  View Current Recommendation →
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
<div class="sidebar-card highlight sticky-main-cta review-cta">
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
${generateRotatingRelatedGuides(post, posts)}

<!-- DYNAMIC RECOMMENDATION WIDGETS -->

${generateDynamicSidebar(posts)}

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

${generateSiteTrustSignals()}

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
  const reviewPool = ${JSON.stringify(reviewRotationData)};
  const supportingPool = ${JSON.stringify(supportingRotationData)};
  const currentUrl = ${JSON.stringify(post.url)};

  function rotatePool(pool, seed, count){
    const available = (pool || []).filter(item => item.url !== currentUrl);
    if(!available.length) return [];
    const offset = Math.abs(seed) % available.length;
    const rotated = available.slice(offset).concat(available.slice(0,offset));
    return rotated.slice(0,Math.max(1,count || 1));
  }

  const pageSeed = Array.from(currentUrl).reduce(
    (total,ch)=>total + ch.charCodeAt(0),0
  );

  const reviewTargets = rotatePool(
    reviewPool,
    pageSeed,
    Math.max(1,reviewPool.length)
  );

  const supportingTargets = rotatePool(
    supportingPool,
    pageSeed + 17,
    3
  );

  /*
    REVIEW-ONLY CTA RULE:
    These CTAs can ONLY point to review posts.
    Supporting posts are never assigned here.
  */
  const reviewButtons = document.querySelectorAll(
    ".review-cta .cta-btn, .comparison-block .cta-btn, .sidebar .sticky-main-cta .sidebar-btn"
  );

  reviewButtons.forEach((btn,index)=>{
    const target = reviewTargets[index % Math.max(1,reviewTargets.length)];
    if(!target) return;

    btn.href = target.url;

    if(
      btn.innerText.includes("See #1 Tool") ||
      btn.innerText.includes("See Tool") ||
      btn.innerText.includes("See The Proven Tool") ||
      btn.innerText.includes("See Best Tool")
    ){
      btn.innerHTML = "Check Out " + target.title + " →";
    }
  });

  /*
    SUPPORTING-ONLY CTA/NAVIGATION RULE:
    Continue Reading and Related Guides can ONLY point
    to supporting posts.
  */
  const supportingLinks = document.querySelectorAll(
    ".internal-widget .internal-list a, .sidebar .related-guides-widget a"
  );

  supportingLinks.forEach((link,index)=>{
    const target = supportingTargets[index % Math.max(1,supportingTargets.length)];
    if(target) link.href = target.url;
  });

  /*
    REVIEW-ONLY STROLL CTA.
  */
  const strollCta = document.querySelector(".stroll-main-cta");

  if(strollCta && reviewTargets.length){
    const strollTarget =
      reviewTargets[(pageSeed + 3) % reviewTargets.length];

    const strollLink = strollCta.querySelector("a");

    if(strollLink){
      strollLink.href = strollTarget.url;
      strollLink.innerHTML =
        "Top Choice: " + strollTarget.title + " →";
    }

    window.addEventListener("scroll",function(){
      const scrollPercent =
        (window.scrollY /
        Math.max(
          1,
          document.body.scrollHeight - window.innerHeight
        )) * 100;

      strollCta.classList.toggle(
        "active",
        scrollPercent > 35
      );
    },{passive:true});
  }

  /*
    REVIEW-ONLY EXIT POPUP.
  */
  let popupShown = false;

  document.addEventListener("mouseleave",function(e){
    if(
      e.clientY > 0 ||
      popupShown ||
      !reviewTargets.length
    ) return;

    popupShown = true;

    const target =
      reviewTargets[(pageSeed + 5) % reviewTargets.length];

    const popup = document.createElement("div");
    popup.className = "exit-popup-overlay";

    popup.innerHTML =
      '<div class="exit-popup">' +
        '<h3>Don\\'t Miss Our Recommendation</h3>' +
        '<p>Our current review model recommends <strong>' +
        target.title +
        '</strong> for this page.</p>' +
        '<a href="' +
        target.url +
        '" class="cta-btn">Read Full Review →</a>' +
        '<span class="close-popup">✕</span>' +
      '</div>';

    document.body.appendChild(popup);

    const close =
      popup.querySelector(".close-popup");

    if(close){
      close.onclick = () => popup.remove();
    }
  });
});
</script>
${post.isReview ? `
<div class="stroll-main-cta review-cta">
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
<a href="javascript:void(0)" class="cta-btn review-cta">See #1 Tool →</a>
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
<script>
window.addEventListener("load",function(){
  const pool = ${JSON.stringify(reviewRotationData)};
  if(!pool.length) return;
  const seed = Array.from(location.pathname).reduce((n,ch)=>n+ch.charCodeAt(0),0);
  const target = pool[Math.abs(seed) % pool.length];
  const btn = document.querySelector(".money-cta .review-cta");
  if(btn){
    btn.href = target.url;
    btn.textContent = "Check Out " + target.title + " →";
  }
});
</script>
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

  const categoryPosts =
    topics[topic]
      .filter(p=>p.isReview);

  const topicTitle = formatCategoryTitle(topic);
  const topicURL = `${SITE_URL}/ai-tools/${topic}/`;

  const topPicks =
    [...categoryPosts]
      .sort((a,b)=>
        Number(b.score?.score || 0) -
        Number(a.score?.score || 0)
      )
      .slice(0,5);

  const latest =
    [...categoryPosts]
      .sort((a,b)=>
        new Date(b.date) - new Date(a.date)
      )
      .slice(0,6);

  const editorChoice =
    topPicks[0];

  const comparisonCandidates =
    categoryPosts.slice(0,2);

  const comparisonHTML =
    comparisonCandidates.length >= 2
      ? `
        <table class="comparison-table">
          <thead>
            <tr>
              <th>Feature</th>
              ${comparisonCandidates.map(p=>
                `<th>${escapeHtml(p.product?.name || p.title)}</th>`
              ).join("")}
            </tr>
          </thead>

          <tbody>
            ${[
              ["Speed","easeOfUse"],
              ["AI Quality","accuracy"],
              ["Templates","features"],
              ["Automation","automation"],
              ["Support","support"],
              ["Pricing","pricing"]
            ].map(([label,key])=>`
              <tr>
                <td>${label}</td>
                ${comparisonCandidates.map(p=>{
                  const value = Number(p.reviewScore?.[key] || 0);
                  return `<td>${value ? `${"★".repeat(Math.round(value))}${"☆".repeat(Math.max(0,10-Math.round(value)))}` : "Not scored"}</td>`;
                }).join("")}
              </tr>`).join("")}
            <tr class="comparison-score-row">
              <td><strong>Overall Score</strong></td>
              ${comparisonCandidates.map(p=>`<td><strong>${p.score?.score ? `${p.score.score}/100` : "Pending"}</strong></td>`).join("")}
            </tr>
          </tbody>
        </table>
      `
      : "<p>More reviews will unlock category comparisons.</p>";

  const html = `
<!doctype html>
<html lang="en">

<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>Best ${escapeHtml(topicTitle)} | Tested AI Tools</title>

<meta
  name="description"
  content="Independent ${escapeHtml(topicTitle)} reviews, rankings, comparisons, buying guidance and latest testing results."
>

<link rel="canonical" href="${topicURL}">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>

<body>

${globalHeader()}

<div class="container category-authority-page">

<h1>${escapeHtml(topicTitle)}</h1>

<section class="category-introduction">
  <h2>Introduction</h2>

  <p>
    Explore independently evaluated ${escapeHtml(topicTitle)}
    based on structured testing, usability, performance,
    pricing, workflow suitability and competitive positioning.
  </p>
</section>

<section>
  <h2>Top Picks</h2>

  <div class="hub-grid">
    ${topPicks.map(p=>`
      <div class="hub-card">
        <h3>
          <a href="${p.url}">
            ${escapeHtml(p.product?.name || p.title)}
          </a>
        </h3>

        <p>
          Overall Score:
          <strong>${p.score?.score || 0}/100</strong>
        </p>
      </div>
    `).join("")}
  </div>
</section>

<section>
  <h2>Comparison Table</h2>

  <div class="comparison-table-wrapper">
    ${comparisonHTML}
  </div>
</section>

<section class="buying-guide">
  <h2>Buying Guide</h2>

  <h3>How to choose</h3>
  <p>
    Compare actual workflow fit, output quality, usability,
    pricing, support and long-term value.
  </p>

  <h3>What to avoid</h3>
  <p>
    Avoid selecting software solely because it has the largest
    feature list or the lowest headline price.
  </p>
</section>

<section class="category-faq">
  <h2>FAQ</h2>

  ${safeArray(faqData)
    .filter(group =>
      group.category === "general"
    )
    .flatMap(group=>group.questions || [])
    .map(item=>`
      <div>
        <h3>${escapeHtml(item.question)}</h3>
        <p>${escapeHtml(item.answer)}</p>
      </div>
    `)
    .join("")}
</section>

<section>
  <h2>Editor's Choice</h2>

  ${
    editorChoice
      ? `
        <div class="money-cta">
          <h3>${escapeHtml(editorChoice.title)}</h3>
          <p>
            Current category leader based on the ReviewLab
            scoring framework.
          </p>
          <a href="javascript:void(0)" class="cta-btn review-cta category-rotating-cta">
            Read Editor's Choice →
          </a>
        </div>
      `
      : ""
  }
</section>

<section>
  <h2>Latest Reviews</h2>

  <ul class="post-list">
    ${latest.map(p=>`
      <li>
        <a href="${p.url}">
          ${escapeHtml(p.title)}
        </a>
      </li>
    `).join("")}
  </ul>
</section>

<script>
window.addEventListener("load",function(){
  const pool = ${JSON.stringify(categoryPosts.filter(p=>p.isReview && p.product).map(p=>({
    title:p.title,
    url:p.url,
    score:Number(p.score?.score || 0)
  })))};
  if(!pool.length) return;

  const seed = Array.from(location.pathname)
    .reduce((n,ch)=>n+ch.charCodeAt(0),0);

  document.querySelectorAll(".category-rotating-cta")
    .forEach((btn,index)=>{
      const item = pool[(Math.abs(seed)+index) % pool.length];
      if(item){
        btn.href = item.url;
        btn.textContent = "Read " + item.title + " →";
      }
    });
});
</script>

${generateSiteTrustSignals()}

</div>

</body>
</html>
`;

  const outputDir = `_site/ai-tools/${topic}`;

  fs.mkdirSync(outputDir,{recursive:true});

  fs.writeFileSync(
    `${outputDir}/index.html`,
    html
  );
}

/* =========================================================
   AI GLOSSARY
   ========================================================= */

fs.mkdirSync("_site/glossary",{recursive:true});

const glossaryCards = glossary.map(item=>`
  <article class="glossary-card">
    <h2>
      <a href="${SITE_URL}/glossary/${item.slug}/">
        ${escapeHtml(item.term)}
      </a>
    </h2>

    <p>${escapeHtml(item.definition)}</p>
  </article>
`).join("");

fs.writeFileSync(
  "_site/glossary/index.html",
`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Glossary | ReviewLab</title>
<meta
 name="description"
 content="Definitions of important artificial intelligence, machine learning and AI automation terms."
>
<link rel="canonical" href="${SITE_URL}/glossary/">
<link rel="stylesheet" href="${SITE_URL}/assets/styles.css">
</head>

<body>

${globalHeader()}

<div class="container">

<h1>AI Glossary</h1>

<p>
Understand the terminology behind artificial intelligence,
machine learning, automation and modern AI software.
</p>

<div class="hub-grid">
${glossaryCards}
</div>

</div>

</body>
</html>
`
);

glossary.forEach(item=>{

  const dir = `_site/glossary/${item.slug}`;

  fs.mkdirSync(dir,{recursive:true});

  fs.writeFileSync(
    `${dir}/index.html`,
`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>${escapeHtml(item.term)} | AI Glossary | ReviewLab</title>

<link
 rel="canonical"
 href="${SITE_URL}/glossary/${item.slug}/"
>

<link rel="stylesheet"
 href="${SITE_URL}/assets/styles.css">
</head>

<body>

${globalHeader()}

<div class="container">

<h1>${escapeHtml(item.term)}</h1>

<p>${escapeHtml(item.definition)}</p>

</div>

</body>
</html>
`
  );

});

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
  title: p.title,
  url: p.url,
  description: p.description,
  category: p.category,
  keywords: safeArray(p.product?.keywords),
  tags: safeArray(p.tags),
  pros: safeArray(p.pros),
  cons: safeArray(p.cons),
  bestFor: safeArray(p.product?.bestFor),
  features: safeArray(p.product?.features),
  entities: safeArray(p.entities),
  audience: safeArray(p.product?.audience),
  useCases: safeArray(p.product?.useCases),
  score: p.score?.score || 0,
  isReview: !!p.isReview
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

/* Site configuration is static; all authority datasets above are generated automatically. */
if(fs.existsSync("_data/site.json")) fs.copyFileSync("_data/site.json","_site/_data/site.json");

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
<section class="homepage-authority-grid">
  ${(() => {
    const reviewPosts = posts.filter(p=>p.isReview);
    const latest = [...reviewPosts].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,4);
    const topRated = [...reviewPosts].filter(p=>p.score?.score).sort((a,b)=>b.score.score-a.score.score).slice(0,4);
    const editor = rankedRecommendations[0]?.post;
    const updated = [...reviewPosts].sort((a,b)=>new Date(b.product?.lastUpdated || b.date)-new Date(a.product?.lastUpdated || a.date)).slice(0,4);
    const compared = [...reviewPosts].sort((a,b)=>((generatedComparisons.get(b.slug)||[]).length)-((generatedComparisons.get(a.slug)||[]).length)).slice(0,4);
    const render = (title,items) => `<section class="homepage-authority-section"><h2>${title}</h2><ul>${items.map(p=>`<li><a href="${p.url}">${escapeHtml(p.title)}</a></li>`).join("")}</ul></section>`;
    return render("Latest Reviews",latest) + render("Top Rated",topRated) + (editor ? `<section class="homepage-authority-section featured"><h2>Editor's Choice</h2><a href="${editor.url}">${escapeHtml(editor.title)}</a><strong>${editor.score?.score ? `${editor.score.score}/100` : "Pending"}</strong></section>` : "") + render("Recently Updated",updated) + render("Most Compared",compared) + `<section class="homepage-authority-section"><h2>Popular Categories</h2><ul>${Object.keys(topics).map(cat=>`<li><a href="${SITE_URL}/ai-tools/${cat}/">${escapeHtml(formatCategoryTitle(cat))}</a></li>`).join("")}</ul></section>`;
  })()}
</section>

${generateSiteTrustSignals()}

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
io.unobserve(img);}
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
.filter(p=>{
  const haystack = [
    p.title,
    p.description,
    p.category,
    ...safeArray(p.keywords),
    ...safeArray(p.tags),
    ...safeArray(p.pros),
    ...safeArray(p.cons),
    ...safeArray(p.bestFor),
    ...safeArray(p.features),
    ...safeArray(p.entities),
    ...safeArray(p.audience),
    ...safeArray(p.useCases)
  ]
  .join(" ")
  .toLowerCase();

  return haystack.includes(val);
})
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
