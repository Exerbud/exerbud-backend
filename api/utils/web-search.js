// api/utils/web-search.js

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;

/**
 * Run a Google Custom Search for the given query.
 * Returns a small array of { title, url, snippet } objects.
 */
async function webSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    console.warn(
      "webSearch: GOOGLE_API_KEY or GOOGLE_CX missing, skipping web search."
    );
    return [];
  }

  const params = new URLSearchParams({
    key: GOOGLE_API_KEY,
    cx: GOOGLE_CX,
    q: query,
    num: "5", // top 5 results is enough context
  });

  const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      console.error("webSearch: Google API error", res.status, text);
      return [];
    }

    const data = await res.json();

    if (!Array.isArray(data.items)) {
      return [];
    }

    return data.items.map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet || "",
    }));
  } catch (err) {
    console.error("webSearch: request failed", err);
    return [];
  }
}

module.exports = { webSearch };
