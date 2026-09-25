/** Synthetic overview receipt. Never read customer metadata. */
export const overviewId='11111111-1111-4111-8111-111111111111';
export function overviewReceipt(request_id=overviewId,source_id='selected'){
 return {format:'ultrabrain-personal-overview-v1',scope:'owned-all-projects',source_id,request_id,
 observed_at:'2026-09-22T12:00:00.000Z',read_only:true,model_calls:0,trust:'untrusted-memory-metadata',
 memories:{total:12,candidate:5,active:4,archived:3,active_current:3,active_stale:1,candidate_stale:2,document_fragments:2},
 jobs:{total:15,queued:2,processing:4,completed:3,failed:5,stale:1,processing_live:1,processing_expired:3,failed_below_attempt_limit:2},
 documents:{total:3,active:2,archived:1},agents:{total:2}};
}
