// api/utils/web-search.js

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY; // for static map thumbnails

/**
 * Build a Google Static Maps URL for a given place/query.
 * Returns null if GOOGLE_MAPS_API_KEY is not set.
 */
function buildStaticMapUrl(placeTitle, originalQuery) {
  if (!GOOGLE_MAPS_API_KEY) return null;

  const base = "https://maps.googleapis.com/maps/api/staticmap";

  // Use the place title + user query as a loose location string.
  // Example: "CrossFit Buffalo buffalo 14216"
  const centerText = `${placeTitle || ""} ${originalQuery || ""}`.trim();
  if (!centerText) return null;

  const center = encodeURIComponent(centerText);
  const size = "320x200"; // px
  const zoom = "14";

  // Simple marker at the same location
  const markers = `color:red|${center}`;

  return `${base}?center=${center}&zoom=${zoom}&size=${size}&markers=${markers}&key=${GOOGLE_MAPS_API_KEY}`;
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
      const link = item.link || "";
      const snippet = item.snippet || "";

      const mapImageUrl = buildStaticMapUrl(title, query);

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
