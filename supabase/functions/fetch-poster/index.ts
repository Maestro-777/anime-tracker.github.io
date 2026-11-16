const ALLOWED_ORIGINS = new Set(["https://maestro-777.github.io","http://localhost:8000","http://127.0.0.1:8000"]);
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg","image/png","image/webp","image/gif","image/avif"]);
function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://maestro-777.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function allowedSource(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if(url.protocol!=="https:" || (url.port && url.port!=="443") || url.username || url.password) return false;
  const host=url.hostname.toLowerCase();
  if(/^s[1-6]\.anilist\.co$/.test(host)) return true;
  if((host==="shikimori.one" || host.endsWith(".shikimori.one")) && url.pathname.startsWith("/system/animes/")) return true;
  if((host==="media.kitsu.io" || host==="media.kitsu.app") && url.pathname.startsWith("/anime/")) return true;
  if(host==="ytmnsnvxjhpejidcndyw.supabase.co" && url.pathname.startsWith("/storage/v1/object/public/animevault-posters/")) return true;
  return false;
}
function jsonError(message: string,status: number,headers: Record<string,string>) {
  return new Response(JSON.stringify({error:message}),{status,headers:{...headers,"Content-Type":"application/json; charset=utf-8"}});
}
Deno.serve(async (request: Request) => {
  const cors=corsHeaders(request.headers.get("origin"));
  if(request.method==="OPTIONS") return new Response("ok",{headers:cors});
  if(request.method!=="POST") return jsonError("Method not allowed",405,cors);
  if(!request.headers.get("authorization")?.startsWith("Bearer ")) return jsonError("AnimeVault authentication required",401,cors);
  try {
    const body=await request.json();
    const sourceUrl=String(body?.sourceUrl||"");
    if(!allowedSource(sourceUrl)) return jsonError("HTTPS poster source host/path is not on the AnimeVault allowlist",400,cors);
    let current=new URL(sourceUrl), response: Response|null=null, redirects=0;
    while(redirects<=5) {
      response=await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(20000)});
      if(![301,302,303,307,308].includes(response.status)) break;
      const location=response.headers.get("location");
      if(!location) return jsonError("Poster source redirect did not include a location",502,cors);
      const next=new URL(location,current);
      if(!allowedSource(next.href)) return jsonError("Poster source redirected to a non-allowed host or path",400,cors);
      current=next;
      redirects++;
    }
    if(!response) return jsonError("Poster source returned no response",502,cors);
    if([301,302,303,307,308].includes(response.status)) return jsonError("Poster source exceeded the redirect limit",502,cors);
    if(!response.ok) return jsonError(`Poster source returned HTTP ${response.status}`,502,cors);
    const mimeType=(response.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
    if(!ALLOWED_TYPES.has(mimeType)) return jsonError(`Unsupported image content type: ${mimeType||"missing"}`,415,cors);
    const declared=Number(response.headers.get("content-length")||0);
    if(declared>MAX_BYTES) return jsonError("Poster exceeds 10 MB limit",413,cors);
    if(!response.body) return jsonError("Poster source returned an empty response",502,cors);
    const reader=response.body.getReader(), chunks: Uint8Array[]=[];
    let total=0;
    while(true) {
      const {done,value}=await reader.read(); if(done) break;
      total+=value.byteLength;
      if(total>MAX_BYTES) { await reader.cancel(); return jsonError("Poster exceeds 10 MB limit",413,cors); }
      chunks.push(value);
    }
    const bytes=new Uint8Array(total); let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return new Response(bytes,{status:200,headers:{...cors,"Content-Type":mimeType,"Content-Length":String(total),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  } catch(error) {
    return jsonError(error instanceof Error?error.message:"Unexpected poster fetch error",500,cors);
  }
});
