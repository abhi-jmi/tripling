// Places API (New). No prediction caching, user identifiers or session tokens are
// sent. Each debounced autocomplete call is billed as an individual request.
export function createPlacesAutocomplete({
  apiKey = process.env.GOOGLE_PLACES_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) return null;
  return async (input) => {
    const response = await fetchImpl(
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text",
        },
        body: JSON.stringify({
          input,
          includedPrimaryTypes: ["(cities)"],
          languageCode: "en",
          regionCode: "in",
          locationBias: {
            rectangle: {
              low: { latitude: 6, longitude: 68 },
              high: { latitude: 37.6, longitude: 97.5 },
            },
          },
        }),
        signal: AbortSignal.timeout(4000),
      },
    );
    // Never expose provider response bodies: they may contain sensitive config.
    if (!response.ok) throw new Error("PLACES_UNAVAILABLE");
    const body = await response.json();
    if (!Array.isArray(body.suggestions || []))
      throw new Error("PLACES_UNAVAILABLE");
    const seen = new Set();
    return (body.suggestions || [])
      .flatMap(({ placePrediction: place }) => {
        const value = place?.structuredFormat?.mainText?.text?.trim();
        const label = place?.text?.text?.trim();
        if (!value || !label || value.length > 60 || seen.has(label)) return [];
        seen.add(label);
        return [{ value, label }];
      })
      .slice(0, 5);
  };
}
