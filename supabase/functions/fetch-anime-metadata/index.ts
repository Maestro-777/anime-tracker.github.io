const ALLOWED_ORIGINS = new Set(["https://maestro-777.github.io","http://localhost:8000","http://127.0.0.1:8000"]);
const ANILIST_ENDPOINTS = ["https://graphql.anilist.co","https://graphql.anilist.co/"];
const SHIKIMORI_API = "https://shikimori.one/api";
const KITSU_API = "https://kitsu.io/api/edge";
const USER_AGENT = "AnimeVault/2.0 (https://github.com/Maestro-777/anime-tracker.github.io)";
let anilistDisabledUntil=0;
let anilistDisabledReason="";
const FIELDS = "id idMal title { romaji english native } description(asHtml: false) episodes duration format seasonYear averageScore genres coverImage { extraLarge large medium }";
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
function corsHeaders(origin:string|null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://maestro-777.github.io";
  return {"Access-Control-Allow-Origin":allowed,"Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"};
}
function json(data:unknown,status:number,headers:Record<string,string>) {
  return new Response(JSON.stringify(data),{status,headers:{...headers,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
}
function clean(value:unknown) {
  return String(value||"").replace(/<br\s*\/?\s*>/gi," ").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/g,"&").replace(/&#039;/g,"'").replace(/&quot;/g,'"').trim().slice(0,5000);
}
function normalize(value:unknown) {
  return String(value||"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," ");
}
function similarity(a:string,b:string) {
  if(!a||!b)return 0;if(a===b)return 1;
  if(a.includes(b)||b.includes(a))return Math.min(a.length,b.length)/Math.max(a.length,b.length);
  const aa=new Set(a.split(" ")),bb=new Set(b.split(" "));
  return [...aa].filter(x=>bb.has(x)).length/Math.max(1,new Set([...aa,...bb]).size);
}
function absoluteImage(value:unknown,base:string) {
  const raw=String(value||"");if(!raw)return "";
  try {const u=new URL(raw,base);return u.protocol==="https:"?u.href:"";}catch{return "";}
}
function normalizeAniList(media:any) {
  if(!media?.id)return null;
  return {anilistId:media.id,malId:media.idMal||null,titleApi:media.title?.english||media.title?.romaji||media.title?.native||"",description:clean(media.description),totalEpisodes:media.episodes||null,episodeDuration:media.duration||null,format:media.format||"",year:media.seasonYear||null,score:media.averageScore||null,genres:Array.isArray(media.genres)?media.genres:[],apiPosterUrl:absoluteImage(media.coverImage?.extraLarge||media.coverImage?.large||media.coverImage?.medium,"https://anilist.co"),metadataProvider:"AniList"};
}
function normalizeShikimori(item:any) {
  if(!item?.id)return null;
  const genreRows=Array.isArray(item.genres)?item.genres:[];
  const date=String(item.aired_on||item.released_on||"");
  const kind=String(item.kind||"").toLowerCase();
  const format=({tv:"TV",movie:"Movie",ova:"OVA",ona:"ONA",special:"Special",tv_special:"Special",music:"Music"} as Record<string,string>)[kind]||kind.toUpperCase();
  return {anilistId:null,malId:Number(item.myanimelist_id)||null,shikimoriId:Number(item.id)||null,titleApi:(Array.isArray(item.english)?item.english[0]:item.english)||item.name||item.russian||"",description:clean(item.description),totalEpisodes:Number(item.episodes)||null,episodeDuration:Number(item.duration)||null,format,year:Number(date.slice(0,4))||null,score:Number(item.score)>0?Math.round(Number(item.score)*10):null,genres:genreRows.map((g:any)=>String(g?.russian||g?.name||"").trim()).filter(Boolean),apiPosterUrl:absoluteImage(item.image?.original||item.image?.preview,"https://shikimori.one"),metadataProvider:"Shikimori"};
}
function normalizeKitsu(item:any) {
  const a=item?.attributes||{};if(!item?.id)return null;
  const title=a.titles?.en||a.titles?.en_jp||a.canonicalTitle||a.titles?.ja_jp||"";
  const start=String(a.startDate||"");
  const relationships=item?.relationships?.genres?.data;
  const included=Array.isArray(item?.__included)?item.__included:[];
  const genres=Array.isArray(relationships)?relationships.map((r:any)=>included.find((x:any)=>x.type==="genres"&&x.id===r.id)?.attributes?.name).filter(Boolean):[];
  return {anilistId:null,malId:null,kitsuId:String(item.id),titleApi:title,description:clean(a.synopsis),totalEpisodes:Number(a.episodeCount)||null,episodeDuration:Number(a.episodeLength)||null,format:String(a.subtype||"").toUpperCase(),year:Number(start.slice(0,4))||null,score:Number(a.averageRating)||null,genres,apiPosterUrl:absoluteImage(a.posterImage?.original||a.posterImage?.large,"https://kitsu.io"),metadataProvider:"Kitsu"};
}
async function readResponse(response:Response) {
  const text=await response.text().catch(()=>"");
  let data:any=null;try{data=text?JSON.parse(text):null;}catch{}
  return {text,data};
}
async function anilistRequest(query:string,variables:Record<string,unknown>={}) {
  if(Date.now()<anilistDisabledUntil) throw Object.assign(new Error(`AniList временно отключён после ошибки: ${anilistDisabledReason}`),{status:404,provider:"AniList"});
  let lastError:any=null;
  for(const endpoint of ANILIST_ENDPOINTS) {
    for(let attempt=0;attempt<3;attempt++) {
      let response:Response;
      try {
        response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json","User-Agent":USER_AGENT},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(12000)});
      } catch(error) {
        lastError=Object.assign(new Error(`AniList network error: ${error instanceof Error?error.message:String(error)}`),{provider:"AniList"});
        if(attempt<2){await sleep(600*2**attempt);continue;}
        break;
      }
      const {text,data}=await readResponse(response);
      if(response.ok) {
        const payload=data||(()=>{throw new Error("AniList returned invalid JSON");})();
        if(payload?.errors?.length)throw new Error(String(payload.errors[0]?.message||"AniList GraphQL error"));
        return payload;
      }
      lastError=Object.assign(new Error(`AniList HTTP ${response.status}: ${text.slice(0,220)}`),{status:response.status,provider:"AniList"});
      if(response.status===404) {
        if(endpoint===ANILIST_ENDPOINTS[ANILIST_ENDPOINTS.length-1]) {
          anilistDisabledUntil=Date.now()+15*60*1000;
          anilistDisabledReason=lastError.message;
        }
        break;
      }
      if([408,425,429,500,502,503,504].includes(response.status)&&attempt<2) {
        const reset=Number(response.headers.get("X-RateLimit-Reset")||0);
        const retryAfter=Number(response.headers.get("Retry-After")||0);
        const wait=retryAfter>0?retryAfter*1000:(reset>0?Math.max(1000,reset*1000-Date.now()+500):700*2**attempt);
        await sleep(Math.min(60000,wait));
        continue;
      }
      break;
    }
  }
  throw lastError||new Error("AniList is unavailable");
}
async function searchShikimori(title:string) {
  const url=new URL(`${SHIKIMORI_API}/animes`);url.searchParams.set("search",title);url.searchParams.set("limit","10");
  const response=await fetch(url,{headers:{"Accept":"application/json","User-Agent":USER_AGENT},signal:AbortSignal.timeout(10000)});
  const {text,data}=await readResponse(response);
  if(!response.ok)throw Object.assign(new Error(`Shikimori HTTP ${response.status}: ${text.slice(0,160)}`),{status:response.status,provider:"Shikimori"});
  if(!Array.isArray(data))throw new Error("Shikimori returned an unexpected response");
  const target=normalize(title);let best:any=null,bestScore=0;
  for(const item of data) {
    const names=[item?.russian,item?.name,...(Array.isArray(item?.english)?item.english:[item?.english]),item?.japanese,...(Array.isArray(item?.synonyms)?item.synonyms:[])].map(normalize).filter(Boolean);
    const score=Math.max(0,...names.map(name=>similarity(target,name)));
    if(score>bestScore){best=item;bestScore=score;}
  }
  return bestScore>=0.48?normalizeShikimori(best):null;
}
async function searchKitsu(title:string) {
  const url=new URL(`${KITSU_API}/anime`);url.searchParams.set("filter[text]",title);url.searchParams.set("page[limit]","5");url.searchParams.set("include","genres");
  const response=await fetch(url,{headers:{"Accept":"application/vnd.api+json","Content-Type":"application/vnd.api+json","User-Agent":USER_AGENT},signal:AbortSignal.timeout(10000)});
  const {text,data}=await readResponse(response);
  if(!response.ok)throw Object.assign(new Error(`Kitsu HTTP ${response.status}: ${text.slice(0,160)}`),{status:response.status,provider:"Kitsu"});
  if(!Array.isArray(data?.data))throw new Error("Kitsu returned an unexpected response");
  const target=normalize(title);let best:any=null,bestScore=0;
  for(const item of data.data) {
    item.__included=Array.isArray(data.included)?data.included:[];
    const a=item.attributes||{};
    const names=[a.canonicalTitle,...Object.values(a.titles||{})].map(normalize).filter(Boolean);
    const score=Math.max(0,...names.map(name=>similarity(target,name)));
    if(score>bestScore){best=item;bestScore=score;}
  }
  return bestScore>=0.45?normalizeKitsu(best):null;
}
async function fetchAniListBatch(titles:string[]) {
  const variables:Record<string,string>={},declarations:string[]=[],selections:string[]=[];
  titles.forEach((title,index)=>{variables[`s${index}`]=title;declarations.push(`$s${index}: String`);selections.push(`m${index}: Media(search: $s${index}, type: ANIME) { ${FIELDS} }`);});
  const query=`query (${declarations.join(", ")}) { ${selections.join(" ")} }`;
  const payload=await anilistRequest(query,variables);
  return new Map(titles.map((title,index)=>[title,normalizeAniList(payload?.data?.[`m${index}`])]).filter((entry:any)=>!!entry[1]));
}
async function probeProvider(name:string,url:string,init:RequestInit={}) {
  const started=Date.now();
  try {
    const response=await fetch(url,{...init,signal:AbortSignal.timeout(9000)});
    const {text}=await readResponse(response);
    return {provider:name,ok:response.ok,status:response.status,latencyMs:Date.now()-started,detail:response.ok?"Доступен":text.slice(0,180)};
  } catch(error) {
    return {provider:name,ok:false,status:0,latencyMs:Date.now()-started,detail:error instanceof Error?error.message:String(error)};
  }
}
Deno.serve(async(request:Request)=>{
  const cors=corsHeaders(request.headers.get("origin"));
  if(request.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(request.method!=="POST")return json({error:"Method not allowed"},405,cors);
  if(!request.headers.get("authorization")?.startsWith("Bearer "))return json({error:"AnimeVault authentication required"},401,cors);
  try {
    const body=await request.json();const action=String(body?.action||"");
    if(action==="diagnostics") {
      const q=JSON.stringify({query:'query { Media(search: "Naruto", type: ANIME) { id title { romaji } } }'});
      const results=await Promise.all([
        probeProvider("AniList (без слэша)","https://graphql.anilist.co",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json","User-Agent":USER_AGENT},body:q}),
        probeProvider("AniList (со слэшем)","https://graphql.anilist.co/",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json","User-Agent":USER_AGENT},body:q}),
        probeProvider("Shikimori",`${SHIKIMORI_API}/animes?search=naruto&limit=1`,{headers:{"Accept":"application/json","User-Agent":USER_AGENT}}),
        probeProvider("Kitsu",`${KITSU_API}/anime?filter%5Btext%5D=naruto&page%5Blimit%5D=1`,{headers:{"Accept":"application/vnd.api+json","User-Agent":USER_AGENT}})
      ]);
      return json({checkedAt:new Date().toISOString(),providers:results},200,cors);
    }
    if(action==="genres") {
      try {
        const payload=await anilistRequest("query { GenreCollection }");
        const genres=Array.isArray(payload?.data?.GenreCollection)?payload.data.GenreCollection.filter(Boolean):[];
        if(genres.length)return json({genres,provider:"AniList"},200,cors);
      } catch(error) { console.warn("AniList genres unavailable:",error instanceof Error?error.message:String(error)); }
      const response=await fetch(`${SHIKIMORI_API}/genres`,{headers:{"Accept":"application/json","User-Agent":USER_AGENT},signal:AbortSignal.timeout(10000)});
      const {text,data}=await readResponse(response);
      if(!response.ok)throw new Error(`Не удалось получить жанры AniList или Shikimori: HTTP ${response.status} ${text.slice(0,160)}`);
      const genres=Array.isArray(data)?data.map((g:any)=>String(g?.russian||g?.name||"").trim()).filter(Boolean):[];
      return json({genres,provider:"Shikimori"},200,cors);
    }
    if(action!=="metadata")return json({error:"Unknown action"},400,cors);
    const titles=[...new Set((Array.isArray(body?.titles)?body.titles:[]).map((v:unknown)=>String(v||"").trim().slice(0,250)).filter(Boolean))].slice(0,9);
    if(!titles.length)return json({results:[]},200,cors);
    const results=new Map<string,any>();const providerState:Record<string,any>={};
    try {
      const found=await fetchAniListBatch(titles);providerState.AniList={ok:true,status:200};
      for(const [title,metadata] of found)results.set(title,{searchTitle:title,metadata,status:"found"});
    } catch(error) {
      const status=Number((error as any)?.status)||0;
      providerState.AniList={ok:false,status,error:error instanceof Error?error.message:String(error)};
      console.warn("AniList unavailable; trying alternate providers:",providerState.AniList.error);
    }
    let fallbackRequests=0;
    const paceFallback=async()=>{if(fallbackRequests++>0)await sleep(230);};
    for(const title of titles) {
      if(results.has(title))continue;
      let anyProviderHealthy=false;const errors:string[]=[];
      try {
        await paceFallback();
        const metadata=await searchShikimori(title);anyProviderHealthy=true;
        providerState.Shikimori={ok:true,status:200};
        if(metadata){results.set(title,{searchTitle:title,metadata,status:"found"});continue;}
      } catch(error) {
        const message=error instanceof Error?error.message:String(error);errors.push(message);
        providerState.Shikimori={ok:false,status:Number((error as any)?.status)||0,error:message};
      }
      try {
        await paceFallback();
        const metadata=await searchKitsu(title);anyProviderHealthy=true;
        providerState.Kitsu={ok:true,status:200};
        if(metadata){results.set(title,{searchTitle:title,metadata,status:"found"});continue;}
      } catch(error) {
        const message=error instanceof Error?error.message:String(error);errors.push(message);
        providerState.Kitsu={ok:false,status:Number((error as any)?.status)||0,error:message};
      }
      results.set(title,anyProviderHealthy
        ? {searchTitle:title,metadata:null,status:"not_found"}
        : {searchTitle:title,metadata:null,status:"error",error:errors.join(" | ")||"Все источники API недоступны"});
    }
    return json({results:[...results.values()],providers:providerState},200,cors);
  } catch(error) {
    const message=error instanceof Error?error.message:"Unexpected metadata proxy error";
    console.error("AnimeVault metadata proxy:",message);
    return json({error:message},502,cors);
  }
});
