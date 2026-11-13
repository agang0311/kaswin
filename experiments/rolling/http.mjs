/** Optional HTTP host adapter. Importing creates no listener. NOT_RUN.
 * Host supplies authentication/rate limiting for uploads and chooses the bind address.
 */
import {check} from './state.mjs';
const LIMIT=510000;
function reply(res,status,body) {
  const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','content-length':bytes.length,'x-content-type-options':'nosniff'});res.end(bytes);
}
async function writeLine(res,row) {
  check(!res.destroyed,'EXPORT_CONNECTION_CLOSED');
  if(res.write(JSON.stringify(row)+'\n'))return;
  await new Promise((resolve,reject)=>{
    const cleanup=()=>{res.off('drain',drained);res.off('close',closed);res.off('error',failed);};
    const drained=()=>{cleanup();resolve();};
    const closed=()=>{cleanup();reject(new Error('Export connection closed'));};
    const failed=e=>{cleanup();reject(e);};
    res.once('drain',drained);res.once('close',closed);res.once('error',failed);
    if(res.destroyed)closed();
  });
}
export function createRequestHandler(indexer,{authorizeUpload=()=>false}={}) {
  const prefix='/v1/rolling/'+indexer.network+'/'+indexer.profile.id+'/';
  return async(req,res)=>{
    try {
      check(typeof req.url==='string'&&req.url.length<=8192,'REQUEST_PATH');
      const url=new URL(req.url,'https://rolling.invalid');
      if(!url.pathname.startsWith(prefix)){reply(res,404,{error:'UNSUPPORTED_DOMAIN'});return;}
      if(req.method!=='GET'&&req.method!=='PUT'){reply(res,405,{error:'METHOD_NOT_ALLOWED'});return;}
      let body=null;
      if(req.method==='PUT') {
        if(!await authorizeUpload(req)){reply(res,403,{error:'UPLOAD_NOT_AUTHORIZED'});return;}
        if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json')){reply(res,415,{error:'JSON_REQUIRED'});return;}
        const length=req.headers['content-length'];
        if(length!==undefined&&(!/^[0-9]+$/.test(length)||BigInt(length)>BigInt(LIMIT))){reply(res,413,{error:'BODY_LIMIT'});return;}
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>LIMIT){reply(res,413,{error:'BODY_LIMIT'});return;}chunks.push(chunk);}
        body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        check(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1&&typeof body.redeemScript==='string','PREIMAGE_BODY');
      }
      const result=await indexer.request(req.method,url.pathname.slice(prefix.length)+url.search,body);
      if(result.stream) {
        res.writeHead(result.status,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
        for await(const row of result.stream)await writeLine(res,row);
        res.end();return;
      }
      reply(res,result.status,result.body);
    } catch(e) {
      if(res.headersSent){res.destroy();return;}
      const conflict=['CURSOR_STALE','REVISION_CONFLICT','IMMUTABLE_PREIMAGE_CONFLICT'].includes(e.code);
      const known=typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code);
      // Do not expose filesystem paths, raw requests or node adapter errors.
      reply(res,conflict?409:e instanceof SyntaxError||known?400:500,{error:known?e.code:'REQUEST_FAILED'});
    }
  };
}
