const ALLOWED_ORIGINS = new Set(["https://maestro-777.github.io","http://localhost:8000","http://127.0.0.1:8000"]);
const MAX_TEXT = 5000;
const USER_AGENT = "AnimeVault/1.4 (https://github.com/Maestro-777/anime-tracker.github.io)";
function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://maestro-777.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(data: unknown, status: number, headers: Record<string,string>) {
  return new Response(JSON.stringify(data), {status, headers:{...headers,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
}
function normalize(value: unknown) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," ");
}
function cleanDescription(value: unknown) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi,"\n")
    .replace(/<[^>]*>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&#039;/gi,"'")
    .replace(/\[character=[^\]]+\]|\[anime=[^\]]+\]/gi,"")
    .replace(/\[\/character\]|\[\/anime\]/gi,"")
    .replace(/[ \t]+/g," ")
    .replace(/\n\s+/g,"\n")
    .trim()
    .slice(0,MAX_TEXT);
}
function titleSimilarity(a: string,b: string) {
  if(!a||!b) return 0;
  if(a===b) return 1;
  if(a.includes(b)||b.includes(a)) return Math.min(a.length,b.length)/Math.max(a.length,b.length);
  const aa=new Set(a.split(" ")),bb=new Set(b.split(" "));
  const overlap=[...aa].filter(x=>bb.has(x)).length;
  return overlap/Math.max(1,new Set([...aa,...bb]).size);
}
async function findShikimoriDescription(title: string, malId: number | null) {
  if(!title) return "";
  const url=new URL("https://shikimori.one/api/animes");
  url.searchParams.set("search",title);
  url.searchParams.set("limit","10");
  const response=await fetch(url,{headers:{"Accept":"application/json","User-Agent":USER_AGENT},signal:AbortSignal.timeout(12000)});
  if(response.status===429) throw new Error("Shikimori ограничил частоту запросов. Повторите позже.");
  if(!response.ok) throw new Error(`Shikimori HTTP ${response.status}`);
  const rows=await response.json();
  if(!Array.isArray(rows)) return "";
  let selected=null;
  if(malId) selected=rows.find((item:any)=>Number(item?.myanimelist_id)===Number(malId))||null;
  if(!selected) {
    const target=normalize(title);
    let best=0;
    for(const item of rows) {
      const names=[item?.russian,item?.name,item?.english,item?.japanese,...(Array.isArray(item?.synonyms)?item.synonyms:[])].map(normalize).filter(Boolean);
      const score=Math.max(0,...names.map(name=>titleSimilarity(target,name)));
      if(score>best){best=score;selected=item;}
    }
    if(best<0.72) selected=null;
  }
  return selected ? cleanDescription(selected.description) : "";
}
async function translateToRussian(source: string) {
  const text=source.slice(0,MAX_TEXT);
  const url=new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client","gtx");
  url.searchParams.set("sl","auto");
  url.searchParams.set("tl","ru");
  url.searchParams.set("dt","t");
  url.searchParams.set("q",text);
  const response=await fetch(url,{headers:{"User-Agent":USER_AGENT},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`Сервис перевода HTTP ${response.status}`);
  const data=await response.json();
  const translated=Array.isArray(data?.[0])?data[0].map((part:any)=>String(part?.[0]||"")).join("").trim():"";
  if(!translated) throw new Error("Сервис перевода не вернул русский текст.");
  return translated.slice(0,MAX_TEXT);
}
Deno.serve(async (request: Request) => {
  const cors=corsHeaders(request.headers.get("origin"));
  if(request.method==="OPTIONS") return new Response("ok",{headers:cors});
  if(request.method!=="POST") return json({error:"Method not allowed"},405,cors);
  if(!request.headers.get("authorization")?.startsWith("Bearer ")) return json({error:"AnimeVault authentication required"},401,cors);
  try {
    const body=await request.json();
    const title=String(body?.title||"").trim().slice(0,250);
    const malId=Number(body?.malId)||null;
    const original=cleanDescription(body?.description);
    if(!title&&!original) return json({descriptionRu:"",source:"not_found"},200,cors);
    let shikimoriDescription="",shikimoriFailed=false;
    try { shikimoriDescription=await findShikimoriDescription(title,malId); }
    catch(error) { shikimoriFailed=true;console.warn("AnimeVault Shikimori lookup:",error); }
    if(shikimoriDescription && /[А-Яа-яЁё]/.test(shikimoriDescription)) {
      return json({descriptionRu:shikimoriDescription,source:"shikimori"},200,cors);
    }
    if(!shikimoriDescription && /[А-Яа-яЁё]/.test(original)) {
      return json({descriptionRu:original,source:"anilist_russian"},200,cors);
    }
    const textToTranslate=shikimoriDescription||original;
    if(!textToTranslate) {
      if(shikimoriFailed) throw new Error("Shikimori не ответил, а исходного описания для перевода нет.");
      return json({descriptionRu:"",source:"not_found"},200,cors);
    }
    const descriptionRu=await translateToRussian(textToTranslate);
    return json({descriptionRu,source:shikimoriDescription?"translated_shikimori":"google_translate"},200,cors);
  } catch(error) {
    const message=error instanceof Error?error.message:"Unexpected description lookup error";
    console.error("AnimeVault description lookup failed:",message);
    return json({error:message},503,cors);
  }
});
