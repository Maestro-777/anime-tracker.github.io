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
  const url = new URL(value);
  if(url.protocol!=="https:") return false;
  if(/^s[1-6]\.anilist\.co$/.test(url.hostname)) return true;
  if(["shikimori.one","desu.shikimori.one"].includes(url.hostname)) return url.pathname.startsWith("/system/animes/");
  if(url.hostname==="media.kitsu.io") return true;
  if(url.hostname==="ytmnsnvxjhpejidcndyw.supabase.co") return url.pathname.startsWith("/storage/v1/object/public/animevault-posters/");
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
    let current=new URL(sourceUrl), response: Response|null=null;
    for(let attempt=0;attempt<4;attempt++) {
      response=await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(20000)});
      if([301,302,303,307,308].includes(response.status)) {
        const location=response.headers.get("location");
        if(!location) return jsonError("Poster source redirect did not include a location",502,cors);
        current=new URL(location,current);
        if(!allowedSource(current.href)) return jsonError("Poster source redirected to a non-allowed host",400,cors);
        continue;
      }
      break;
    }
    if(!response||!response.ok) return jsonError(`Poster source returned HTTP ${response?.status||502}`,502,cors);
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
