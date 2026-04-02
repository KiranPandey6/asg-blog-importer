const fetch = require("cross-fetch");
const cheerio = require("cheerio");

// ================= CONFIG =================
const SHOPIFY_STORE = "bullionbox-dev.myshopify.com";
const ACCESS_TOKEN = process.env.SHOPIFY_TOKEN;
const BLOG_ID = "104347074785";
// ==========================================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ================= GET ALL ARTICLES =================
async function getAllArticles() {
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

  console.log(`📚 Total articles: ${articles.length}`);
  return articles;
}

// ================= EXTRACT SOURCE URL =================
function getSourceUrl(tags) {
  if (!tags) return null;

  const tagList = tags.split(",");
  for (let tag of tagList) {
    tag = tag.trim();
    if (tag.startsWith("source:")) {
      return tag.replace("source:", "").trim();
    }
  }
  return null;
}

// ================= FETCH DATE FROM HTML =================
async function getPublishDate(url) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    // 🧠 Try more targeted approach first

    // 1. Look near title (most reliable)
    const possibleText = $("h1")
      .parent()
      .text();

    let match = possibleText.match(
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/
    );

    // 2. Fallback → search entire body (your approach, but secondary)
    if (!match) {
      const bodyText = $("body").text();

      match = bodyText.match(
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/
      );
    }

    // 3. Convert to ISO
    if (match) {
      const d = new Date(match[0]);
      if (!isNaN(d)) {
        return d.toISOString();
      }
    }

    return null;
  } catch {
    console.log("❌ Failed:", url);
    console.log("📅 Found date:", match ? match[0] : "NONE");
    return null;
  }
}

// ================= UPDATE ARTICLE =================
async function updateArticle(articleId, publishDate) {
  try {
    await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/blogs/${BLOG_ID}/articles/${articleId}.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          article: {
            id: articleId,
            published_at: publishDate,
          },
        }),
      }
    );

    console.log("✅ Updated:", articleId);
  } catch {
    console.log("❌ Failed update:", articleId);
  }
}

// ================= MAIN =================
async function run() {
  console.log("🚀 Starting date update...");

  const articles = await getAllArticles();

  for (const article of articles) {
    const sourceUrl = getSourceUrl(article.tags);

    if (!sourceUrl) continue;

    console.log("🔍 Checking:", article.title);

    const correctDate = await getPublishDate(sourceUrl);

    if (!correctDate) {
      console.log("⏭ No date found");
      continue;
    }

    // Skip if already correct
    if (article.published_at === correctDate) {
      console.log("⏭ Already correct");
      continue;
    }

    await updateArticle(article.id, correctDate);

    await delay(800); // prevent rate limit
  }

  console.log("🎉 All dates updated!");
}

run();