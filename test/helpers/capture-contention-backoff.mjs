/** Deterministic retry schedule for the fixed synthetic contention fixture. */
export const CONTENTION_BACKOFF_MIN_MS=25;
export const CONTENTION_BACKOFF_MAX_MS=120;
const CONTENTION_WORKERS=8;
const CONTENTION_EVENTS=3;
const CONTENTION_RETRIES=7;
const CONTENTION_BACKOFF_SPAN=CONTENTION_BACKOFF_MAX_MS-CONTENTION_BACKOFF_MIN_MS+1;

export function contentionBackoff(worker,event,retries){
 if(!Number.isSafeInteger(worker)||worker<0||worker>=CONTENTION_WORKERS)throw new RangeError('worker');
 if(!Number.isSafeInteger(event)||event<0||event>=CONTENTION_EVENTS)throw new RangeError('event');
 if(!Number.isSafeInteger(retries)||retries<1||retries>CONTENTION_RETRIES)throw new RangeError('retries');
 return CONTENTION_BACKOFF_MIN_MS+((worker*37+event*17+retries*29)%CONTENTION_BACKOFF_SPAN);
}
