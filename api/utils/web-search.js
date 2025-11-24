// api/utils/web-search.js

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
// You can use a separate Static Maps key, or reuse GOOGLE_API_KEY
const GOOGLE_STATIC_MAPS_KEY = process.env.GOOGLE_STATIC_MAPS_KEY || GOOGLE_API_KEY;

/**
 * Build a Google Static Maps URL for a given place query.
 * This is just a simple center+marker map preview.
 */
function buildStaticMapUrl(query) {
  if (!GOOGLE_STATIC_MAPS_KEY) return null;
  if (!query) return null;

  const params = new URLSearchParams({
    center: query,
    zoom: "14",
    size: "600x400",
    scale: "2",
    markers: `color:red|${query}`,
    key: GOOGLE_STATIC_MAPS_KEY,
  });

  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

/**
 * Run a Google Custom Search for the given query.
 * Returns a small array of { title, url, snippet, mapImageUrl } objects.
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

    return data.items.map((item) => {
      const title = item.title || "";
      const link = item.link;
      const snippet = item.snippet || "";

      // For the static map, we just use the title as the query
      const mapImageUrl = buildStaticMapUrl(title);

      return {
        title,
        url: link,
        snippet,
        mapImageUrl,
      };
    });
  } catch (err) {
    console.error("webSearch: request failed", err);
    return [];
  }
}

module.exports = { webSearch };
