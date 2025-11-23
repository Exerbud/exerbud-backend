const axios = require("axios");

async function webSearch(query) {
  const url = "https://ddg-api.herokuapp.com/search"; // Free DuckDuckGo mirror

  try {
    const response = await axios.get(url, {
      params: { q: query }
    });

    if (!response.data || !response.data.results) {
      return [];
    }

    return response.data.results.slice(0, 5).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description || ""
    }));
  } catch (err) {
    console.error("Search error:", err.message);
    return [];
  }
}

module.exports = { webSearch };
