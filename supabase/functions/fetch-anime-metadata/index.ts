const ALLOWED_ORIGINS = new Set([
  "https://maestro-777.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const ENDPOINT = "https://graphql.anilist.co";
const USER_AGENT = "AnimeVault/1.5 (https://github.com/Maestro-777/anime-tracker.github.io)";
const FIELDS = "id idMal title { romaji english native } description(asHtml: false) episodes duration format seasonYear averageScore genres coverImage { extraLarge large medium }";

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://maestro-777.github.io";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(data: unknown, status: number, headers: Record<string,string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function clean(value: unknown) {
  return String(value || "").replace(/<br\s*\/?\s*>/gi," ").replace(/<[^>]*>/g," ")
    .replace(/&amp;/g,"&").replace(/&#039;/g,"'").replace(/&quot;/g,'"').trim().slice(0,2500);
}
function normalizeMedia(media: any) {
  if (!media?.id) return null;
  return {
    anilistId: media.id,
    malId: media.idMal || null,
    titleApi: media.title?.english || media.title?.romaji || media.title?.native || "",
    description: clean(media.description),
    totalEpisodes: media.episodes || null,
    episodeDuration: media.duration || null,
    format: media.format || "",
    year: media.seasonYear || null,
    score: media.averageScore || null,
    genres: Array.isArray(media.genres) ? media.genres : [],
    apiPosterUrl: media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || "",
  };
}
async function anilistRequest(query: string, variables: Record<string,unknown> = {}) {
  let lastError = "AniList request failed";
  for (let attempt=0; attempt<3; attempt++) {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 2) throw new Error(`AniList network error: ${lastError}`);
      await new Promise(resolve => setTimeout(resolve, 700 * (2 ** attempt)));
      continue;
    }
    if (response.ok) {
      const payload = await response.json();
      if (payload?.errors?.length) throw new Error(String(payload.errors[0]?.message || "AniList GraphQL error"));
      return payload;
    }
    const status = response.status;
    lastError = `AniList HTTP ${status}`;
    if (![408, 425, 429, 500, 502, 503, 504].includes(status) || attempt === 2) {
      throw new Error(lastError);
    }
    const retryAfter = Number(response.headers.get("Retry-After") || 0);
    const delay = retryAfter > 0 ? Math.min(30000, retryAfter * 1000) : 1000 * (2 ** attempt);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(lastError);
}
Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request.headers.get("origin"));
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
    return json({ error: "AnimeVault authentication required" }, 401, cors);
  }
  try {
    const body = await request.json();
    const action = String(body?.action || "");
    if (action === "genres") {
      const payload = await anilistRequest("query { GenreCollection }");
      const genres = Array.isArray(payload?.data?.GenreCollection) ? payload.data.GenreCollection.filter(Boolean) : [];
      return json({ genres }, 200, cors);
    }
    if (action !== "metadata") return json({ error: "Unknown action" }, 400, cors);
    const titles = [...new Set((Array.isArray(body?.titles) ? body.titles : [])
      .map((value: unknown) => String(value || "").trim().slice(0, 250))
      .filter(Boolean))].slice(0, 9);
    if (!titles.length) return json({ results: [] }, 200, cors);
    const variables: Record<string,string> = {};
    const declarations: string[] = [];
    const selections: string[] = [];
    titles.forEach((title, index) => {
      variables[`s${index}`] = title;
      declarations.push(`$s${index}: String`);
      selections.push(`m${index}: Media(search: $s${index}, type: ANIME) { ${FIELDS} }`);
    });
    const query = `query (${declarations.join(", ")}) { ${selections.join(" ")} }`;
    const payload = await anilistRequest(query, variables);
    const results = titles.map((searchTitle, index) => ({
      searchTitle,
      metadata: normalizeMedia(payload?.data?.[`m${index}`]),
    })).filter(item => item.metadata);
    return json({ results }, 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected AniList proxy error";
    console.error("AnimeVault AniList proxy:", message);
    const status = /429/.test(message) ? 429 : 502;
    return json({ error: message }, status, {
      ...cors,
      ...(status === 429 ? { "Retry-After": "30" } : {}),
    });
  }
});
