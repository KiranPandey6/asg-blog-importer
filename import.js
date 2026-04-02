const axios = require("axios");
const xml2js = require("xml2js");
const cheerio = require("cheerio");

// ================= CONFIG =================
const SHOPIFY_STORE = "bullionbox-dev.myshopify.com";
const ACCESS_TOKEN = process.env.SHOPIFY_TOKEN;
const BLOG_ID = "104347074785";
const RSS_URL = "https://www.americanstandardgold.com/feed-all.xml";
const SITEMAP_URL = "https://www.americanstandardgold.com/sitemap.xml";
// ==========================================

const delay = ms => new Promise(res => setTimeout(res, ms));

// ================= FETCH RSS =================
async function fetchRSS() {
  console.log("📥 Fetching RSS feed...");
  const res = await axios.get(RSS_URL);
  const parser = new xml2js.Parser({ explicitArray: false });
  const data = await parser.parseStringPromise(res.data);
  const items = data.rss.channel.item;
  return Array.isArray(items) ? items : [items];
}

// ================= FETCH SITEMAP =================
async function fetchSitemap() {
  console.log("📥 Fetching sitemap...");
  const res = await axios.get(SITEMAP_URL);
  const parser = new xml2js.Parser({ explicitArray: false });
  const data = await parser.parseStringPromise(res.data);
  const urls = data.urlset.url;
  const allUrls = Array.isArray(urls) ? urls : [urls];

  return allUrls
    .map(u => u.loc)
    .filter(url =>
      url &&
      (url.includes("/blog/") || url.includes("/library/")) &&
      url.endsWith(".cfm") &&
      !url.includes("terms") &&
      !url.includes("disclaimer") &&
      !url.includes(".pdf")
    );
}

// ================= FETCH BLOG HTML =================
async function fetchHTML(url) {
  try {
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch {
    console.log("❌ Failed to fetch:", url);
    return null;
  }
}

// ================= EXTRACT CONTENT FROM HTML =================
function extractContent(html, url) {
  const $ = cheerio.load(html);

  // Get title
  const title = $("h1").first().text().trim();
  if (!title) return null;

  // Get main content
  let content = "";
  const selectors = [
    ".blog-content",
    ".entry-content",
    "article",
    ".main-content",
    ".post-content"
  ];

  for (const selector of selectors) {
    if ($(selector).length) {
      content = $(selector).first().html();
      break;
    }
  }

  // Fallback to paragraphs
  if (!content) {
    content = $("p").map((i, el) => $(el).html()).get().join("");
  }

  if (!content) return null;

  // Fix lazy loaded images
  content = content.replace(/data-src=/g, "src=");
  content = content.replace(/class="lazyload"/g, "");
  content = content.replace(
    /style="height: auto !important; max-width: 100% !important;"/g,
    'style="max-width:100%; height:auto; margin: 20px 0;"'
  );

  return { title, content };
}

// ================= EXTRACT CONTENT FROM RSS =================
function extractRSSContent(item) {
  let content = item["content:encoded"] || item.description || "";

  // Fix lazy loaded images
  content = content.replace(/data-src=/g, "src=");
  content = content.replace(/class="lazyload"/g, "");
  content = content.replace(
    /style="height: auto !important; max-width: 100% !important;"/g,
    'style="max-width:100%; height:auto; margin: 20px 0;"'
  );

  return content;
}

// ================= GET ALL SHOPIFY ARTICLES =================
async function getAllArticles() {
  console.log("📚 Fetching existing Shopify articles...");
  let articles = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/2023-10/blogs/${BLOG_ID}/articles.json?limit=250`;

  while (url) {
    const res = await axios.get(url, {
      headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
    });
    articles = articles.concat(res.data.articles);
    const linkHeader = res.headers.link;
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>; rel="next"/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }

  console.log(`🧠 Found ${articles.length} existing articles`);
  return articles;
}

// ================= GET EXISTING SOURCE URLS =================
function getExistingUrls(articles) {
  const urls = new Set();
  articles.forEach(article => {
    if (article.tags) {
      article.tags.split(",").forEach(tag => {
        const t = tag.trim();
        if (t.startsWith("source:")) {
          urls.add(t.replace("source:", "").trim());
        }
      });
    }
  });
  return urls;
}

// ================= CREATE SHOPIFY ARTICLE =================
async function createArticle(title, bodyHtml, sourceUrl, pubDate) {
  const article = {
    article: {
      title,
      body_html: bodyHtml,
      tags: [`source:${sourceUrl}`],
      published: true,
      published_at: pubDate || new Date().toISOString()
    }
  };

  try {
    await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/blogs/${BLOG_ID}/articles.json`,
      article,
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("✅ Created:", title);
  } catch (err) {
    console.error("❌ Failed to create:", title, err.response?.data || err.message);
  }
}

// ================= MAIN =================
async function run() {
  try {
    console.log("🚀 Starting ASG Blog Import...");

    // Get existing articles to avoid duplicates
    const existingArticles = await getAllArticles();
    const existingUrls = getExistingUrls(existingArticles);
    console.log(`🧠 Found ${existingUrls.size} already imported articles`);

    // ====== STEP 1: Import from RSS ======
    console.log("\n📡 Processing RSS feed...");
    const rssItems = await fetchRSS();
    console.log(`Found ${rssItems.length} items in RSS`);

    for (const item of rssItems) {
      const sourceUrl = item.link;
      if (!sourceUrl) continue;

      if (existingUrls.has(sourceUrl)) {
        console.log("⏭ Skipped (already imported):", item.title);
        continue;
      }

      const content = extractRSSContent(item);
      const title = item.title;
      const pubDate = item.pubDate;

      if (!title || !content) {
        console.log("⏭ Skipped (no content):", sourceUrl);
        continue;
      }

      await createArticle(title, content, sourceUrl, pubDate);
      existingUrls.add(sourceUrl); // prevent duplicate in same run
      await delay(500);
    }

    // ====== STEP 2: Import from Sitemap ======
    console.log("\n🗺 Processing sitemap...");
    const sitemapUrls = await fetchSitemap();
    console.log(`Found ${sitemapUrls.length} blog URLs in sitemap`);

    for (const url of sitemapUrls) {
      if (existingUrls.has(url)) {
        console.log("⏭ Skipped (already imported):", url);
        continue;
      }

      const html = await fetchHTML(url);
      if (!html) continue;

      const extracted = extractContent(html, url);
      if (!extracted) {
        console.log("⏭ Skipped (could not extract):", url);
        continue;
      }

      await createArticle(extracted.title, extracted.content, url, null);
      existingUrls.add(url);
      await delay(1000); // slightly longer delay for HTML fetching
    }

    console.log("\n🎉 Import complete!");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
}

run();