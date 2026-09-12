/** Derived summaries only; source text is always re-read through current native ACLs. */
import {randomUUID} from 'node:crypto';
import {parseUri,uri,requireThat,sha256,layers,clip,UltraError} from './core.mjs';
import {canonicalPage,profileHash,generateSummary,validateDocument} from './semantic-core.mjs';
const safeErrors=new Set(['model_unavailable','summary_timeout','invalid_summary','summary_no_evidence','summary_input_too_large','stale_summary','summary_lease_lost']);
export function summaryView(store,page) {
  return sha256(JSON.stringify([store.readerKey,page.source_id,canonicalPage(page)]));
}
const address=(store,page)=>[page.source_id,page.slug,store.readerKey];
async function reread(store,page) {
  const current=await store.call('get_page',{slug:page.slug,source_id:page.source_id,include_content:true});
  requireThat(current?.source_id===page.source_id&&current.slug===page.slug&&summaryView(store,current)===summaryView(store,page),
    'stale_summary','Original or authorized view changed while generating the summary');
  await store.assertCurrent?.(current);
  return current;
}
export function semanticCache(store) {
  async function lookup(page) {
    if(!store.profile||!store.readerKey)return null;
    const [row]=await store.sql(`SELECT document FROM ultrabrain.summary_cache
      WHERE source_id=$1 AND slug=$2 AND reader_key=$3 AND view_hash=$4 AND profile_hash=$5
        AND state='ready' AND expires_at>now()`,[...address(store,page),summaryView(store,page),profileHash(store.profile)]);
    if(!row)return null;
    try {
      requireThat(row.document?.profile_sha256===profileHash(store.profile),'invalid_summary','Cached profile mismatch');
      return validateDocument(row.document,canonicalPage(page));
    }
    catch {return null;} // corrupted derived data is never served; the original remains authoritative
  }
  async function render(page,level='L0',maxBytes=65536,mode='prefer') {
    requireThat(['prefer','require','off'].includes(mode),'invalid_params','summary must be prefer, require or off');
    const original=layers(page,level,maxBytes);
    if(level==='L2'||mode==='off')return original;
    const document=await lookup(page);
    if(!document) {
      requireThat(mode!=='require','summary_unavailable','No current authorized summary; refresh explicitly or use original text');
      return {...original,summary_status:'not_cached_or_stale',model_calls:0};
    }
    const passages=level==='L0'?[document.abstract]:document.overview;
    const text=passages.map(p=>p.text).join('\n\n');
    const content=clip(text,Math.min(maxBytes,level==='L0'?384:3072));
    const ids=new Set(passages.flatMap(p=>p.evidence_ids));
    return {...original,content,bytes:Buffer.byteLength(content),truncated:content!==text,
      summary_method:document.protocol,summary_status:'ready',model_calls:0,
      summary_generated_at:document.generated_at,profile_sha256:document.profile_sha256,
      citations:document.evidence.filter(e=>ids.has(e.id)).map(({id,quote,start,end,start_line,end_line})=>
        ({id,uri:uri(page.source_id,page.slug),content_sha256:document.content_sha256,quote,start,end,start_line,end_line,offset_unit:'UTF-16 code units'})),
      trust:document.trust,evidence_assurance:document.evidence_assurance};
  }
  async function refresh(p) {
    const target=parseUri(p.uri);
    requireThat(target.slug&&target.source===store.source,'scope_denied','Summary must target the write source');
    await store.assertSummaryAccess(true);
    const page=await store.call('get_page',{slug:target.slug,source_id:target.source,include_content:true});
    requireThat(page?.source_id===target.source&&page.slug===target.slug,'scope_denied','Use the canonical page URI for summary generation; aliases require explicit resolution');
    await store.assertCurrent?.(page);
    const profile=store.profile;
    requireThat(profile,'model_unavailable','Host must explicitly enable a summary profile first');
    const existing=await lookup(page);
    if(existing)return {uri:uri(page.source_id,page.slug),state:'ready',cached:true,document:existing,model_calls:0};
    requireThat(p.allow_model_call===true,'model_consent_required','Explicit allow_model_call:true is required to send authorized source text to the configured model');
    if(store.dryRun)return {dry_run:true,state:'not_generated',model_calls:0};
    // Validate oversize input before reserving a slot or calling a provider.
    const {splitDocument}=await import('./semantic-core.mjs');splitDocument(canonicalPage(page),profile);
    const lease=randomUUID(),view=summaryView(store,page),hash=profileHash(profile);
    const claimed=await store.transaction(async tx=>{
      await tx.executeRaw("SET LOCAL lock_timeout='5s'");
      await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['ultra-summary',page.source_id])]);
      await tx.executeRaw("DELETE FROM ultrabrain.summary_cache WHERE source_id=$1 AND state!='building' AND expires_at<now()",[page.source_id]);
      const [previous]=await tx.executeRaw('SELECT state,expires_at FROM ultrabrain.summary_cache WHERE source_id=$1 AND slug=$2 AND reader_key=$3',address(store,page));
      if(!previous){
        const [count]=await tx.executeRaw('SELECT count(*)::integer AS n FROM ultrabrain.summary_cache WHERE source_id=$1',[page.source_id]);
        requireThat(count.n<10000,'summary_capacity','Summary cache quota reached; remove unused derived entries');
      }
      return tx.executeRaw(`INSERT INTO ultrabrain.summary_cache(source_id,slug,reader_key,view_hash,profile_hash,state,lease_id,expires_at)
        VALUES($1,$2,$3,$4,$5,'building',$6::uuid,now()+interval '3 minutes')
        ON CONFLICT(source_id,slug,reader_key) DO UPDATE SET view_hash=EXCLUDED.view_hash,profile_hash=EXCLUDED.profile_hash,
          state='building',lease_id=EXCLUDED.lease_id,expires_at=EXCLUDED.expires_at,document=NULL,error_code=NULL,updated_at=now()
        WHERE ultrabrain.summary_cache.state!='building' OR ultrabrain.summary_cache.expires_at<now()
        RETURNING state`,[...address(store,page),view,hash,lease]);
    });
    requireThat(claimed.length===1,'busy','A summary is already being generated for this page and reader');
    try {
      const document=await generateSummary(canonicalPage(page),profile,store.generate,{signal:store.signal});
      await reread(store,page);
      const updated=await store.sql(`UPDATE ultrabrain.summary_cache SET state='ready',document=$5::text::jsonb,
        error_code=NULL,expires_at=now()+($6::integer*interval '1 second'),updated_at=now()
        WHERE source_id=$1 AND slug=$2 AND reader_key=$3 AND lease_id=$4::uuid AND state='building' RETURNING state`,
        [...address(store,page),lease,JSON.stringify(document),profile.ttl_seconds]);
      requireThat(updated.length===1,'summary_lease_lost','Summary generation was superseded or forgotten');
      return {uri:uri(page.source_id,page.slug),state:'ready',cached:false,model_calls:document.model_calls.length,document};
    } catch(e) {
      await store.sql(`UPDATE ultrabrain.summary_cache SET state='failed',document=NULL,error_code=$5,
        expires_at=now(),updated_at=now() WHERE source_id=$1 AND slug=$2 AND reader_key=$3 AND lease_id=$4::uuid AND state='building'`,
        [...address(store,page),lease,safeErrors.has(e.code)?e.code:'summary_generation_failed']);
      const code=safeErrors.has(e.code)?e.code:'summary_generation_failed';
      throw new UltraError(code,'Summary was not published; check model configuration, input limits and current source access');
    }
  }
  async function status(p) {
    const target=parseUri(p.uri);requireThat(target.slug,'invalid_uri','Resource path required');
    await store.assertSummaryAccess(false);
    const page=await store.call('get_page',{slug:target.slug,source_id:target.source,include_content:true});
    const memory=store.policy?await store.policy(page):null;
    const document=memory&&!memory.eligible?null:await lookup(page);
    return {uri:uri(page.source_id,page.slug),...(memory?{memory}:{}),state:memory&&!memory.eligible?'excluded_by_memory_policy':document?'ready':'not_cached_or_stale',
      profile_enabled:!!store.profile,content_sha256:sha256(canonicalPage(page)),model_calls:0,
      ...(document?{generated_at:document.generated_at,profile_sha256:document.profile_sha256}:{})};
  }
  async function forget(p) {
    const target=parseUri(p.uri);requireThat(target.slug&&target.source===store.source,'scope_denied','Write source required');
    await store.assertSummaryAccess(true);
    // Resolves aliases and verifies present read authority before touching metadata.
    const page=await store.call('get_page',{slug:target.slug,source_id:target.source,include_content:true});
    if(store.dryRun)return {dry_run:true};
    await store.sql('DELETE FROM ultrabrain.summary_cache WHERE source_id=$1 AND slug=$2 AND reader_key=$3',address(store,page));
    return {forgotten:true,scope:'current reader derived summary only; originals, other readers and backups are unchanged'};
  }
  return {lookup,render,refresh,status,forget};
}
