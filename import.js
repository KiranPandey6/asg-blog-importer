const fetch = require("cross-fetch");
const xml2js = require("xml2js");
const cheerio = require("cheerio");

// ================= CONFIG =================
const SHOPIFY_STORE = "bullionbox-dev.myshopify.com";
const ACCESS_TOKEN = process.env.SHOPIFY_TOKEN;
const BLOG_ID = "104347074785";

const RSS_URL = "https://www.americanstandardgold.com/feed-all.xml";
const SITEMAP_URL = "https://www.americanstandardgold.com/sitemap.xml";
// ==========================================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ================= FETCH RSS =================
async function fetchRSS() {
  console.log("📥 Fetching RSS...");
  const res = await fetch(RSS_URL);
  const text = await res.text();

  const parser = new xml2js.Parser({ explicitArray: false });
  const data = await parser.parseStringPromise(text);

  const items = data.rss.channel.item;
  return Array.isArray(items) ? items : [items];
}

// ================= FETCH SITEMAP =================
async function fetchSitemap() {
  console.log("📥 Fetching Sitemap...");
  const res = await fetch(SITEMAP_URL);
  const text = await res.text();

  const parser = new xml2js.Parser({ explicitArray: false });
  const data = await parser.parseStringPromise(text);

  const urls = data.urlset.url;
  const allUrls = Array.isArray(urls) ? urls : [urls];

  return allUrls
    .map((u) => u.loc)
    .filter(
      (url) =>
        url &&
        (url.includes("/blog/") || url.includes("/library/")) &&
        url.endsWith(".cfm") &&
        !url.includes("terms") &&
        !url.includes("disclaimer") &&
        !url.includes(".pdf")
    );
}

// ================= FETCH HTML =================
async function fetchHTML(url) {
  try {
    const res = await fetch(url);
    return await res.text();
  } catch (err) {
    console.log("❌ Failed:", url);
    return null;
  }
}

// ================= EXTRACT HTML CONTENT =================
function extractContent(html) {
  const $ = cheerio.load(html);

  const title = $("h1").first().text().trim();
  if (!title) return null;

  let content = "";

  const selectors = [
    ".blog-content",
    ".entry-content",
    "article",
    ".main-content",
    ".post-content",
  ];

  for (const sel of selectors) {
    if ($(sel).length) {
      content = $(sel).first().html();
      break;
    }
  }

  if (!content) {
    content = $("p")
      .map((i, el) => $(el).html())
      .get()
      .join("");
  }

  if (!content) return null;

  // Fix images
  content = content.replace(/data-src=/g, "src=");
  content = content.replace(/class="lazyload"/g, "");

  return { title, content };
}

// ================= EXTRACT RSS CONTENT =================
function extractRSSContent(item) {
  let content = item["content:encoded"] || item.description || "";

  content = content.replace(/data-src=/g, "src=");
  content = content.replace(/class="lazyload"/g, "");

  return content;
}

// ================= GET SHOPIFY ARTICLES =================
async function getAllArticles() {
  console.log("📚 Fetching Shopify articles...");

  let articles = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/2023-10/blogs/${BLOG_ID}/articles.json?limit=250`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
    });

    const data = await res.json();
    articles = articles.concat(data.articles);

    const linkHeader = res.headers.get("link");

    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>; rel="next"/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }

  console.log(`🧠 Found ${articles.length} articles`);
  return articles;
}

// ================= GET EXISTING URLS =================
function getExistingUrls(articles) {
  const urls = new Set();

  articles.forEach((a) => {
    if (a.tags) {
      a.tags.split(",").forEach((tag) => {
        const t = tag.trim();
        if (t.startsWith("source:")) {
          urls.add(t.replace("source:", "").trim());
        }
      });
    }
  });

  return urls;
}

// ================= CREATE ARTICLE =================
async function createArticle(title, bodyHtml, sourceUrl, pubDate) {
  const article = {
    article: {
      title,
      body_html: bodyHtml,
      tags: [`source:${sourceUrl}`],
      published: true,
      published_at: pubDate || new Date().toISOString(),
    },
  };

  try {
    await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/blogs/${BLOG_ID}/articles.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(article),
      }
    );

    console.log("✅ Created:", title);
  } catch (err) {
    console.log("❌ Error creating:", title);
  }
}

// ================= MAIN =================
async function run() {
  try {
    console.log("🚀 START");

    const existingArticles = await getAllArticles();
    const existingUrls = getExistingUrls(existingArticles);

    console.log(`🧠 Already imported: ${existingUrls.size}`);

    // ===== RSS =====
    const rssItems = await fetchRSS();

    for (const item of rssItems) {
      const url = item.link;
      if (!url || existingUrls.has(url)) continue;

      const content = extractRSSContent(item);
      const title = item.title;

      await createArticle(title, content, url, item.pubDate);
      existingUrls.add(url);

      await delay(500);
    }

    // ===== SITEMAP =====
    const sitemapUrls = await fetchSitemap();

    for (const url of sitemapUrls) {
      if (existingUrls.has(url)) continue;

      const html = await fetchHTML(url);
      if (!html) continue;

      const data = extractContent(html);
      if (!data) continue;

      await createArticle(data.title, data.content, url, null);
      existingUrls.add(url);

      await delay(1000);
    }

    console.log("🎉 DONE");
  } catch (err) {
    console.error("❌ Fatal:", err.message);
  }
}

run();