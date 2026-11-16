const ALLOWED_ORIGINS = new Set(["https://maestro-777.github.io","http://localhost:8000","http://127.0.0.1:8000"]);
function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://maestro-777.github.io";
  return {"Access-Control-Allow-Origin":allowed,"Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"};
}
Deno.serve((request: Request) => {
  const cors = corsHeaders(request.headers.get("origin"));
  if (request.method === "OPTIONS") return new Response("ok", {headers:cors});
  return new Response(JSON.stringify({error:"Automatic description translation has been retired. AnimeVault metadata enrichment no longer calls this endpoint."}), {
    status:410,
    headers:{...cors,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}
  });
});
