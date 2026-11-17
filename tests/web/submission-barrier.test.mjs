import test from 'node:test';
import assert from 'node:assert/strict';
import {SubmissionBarrier} from './submission-barrier.mjs';

function fixture() {
  let time=0,next=0;const timers=new Map(),sent=[];
  const setTimer=(fn,ms)=>{const id=++next;timers.set(id,{fn,at:time+ms});return id;};
  const clearTimer=id=>timers.delete(id);
  const advance=ms=>{
    const target=time+ms;
    for(;;){const due=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].fn();}
    time=target;
  };
  const barrier=new SubmissionBarrier({windowMs:18,now:()=>time,setTimer,clearTimer});barrier.enabled=true;
  return {barrier,sent,advance,jump:ms=>{time+=ms;},hold:role=>barrier.hold(role,()=>sent.push(role)),setTimer,timers};
}

test('all signed frames can be released before the shared deadline',()=>{
  const f=fixture();f.hold('b2');f.advance(5);f.hold('b1');f.advance(12);
  f.barrier.release('b2');f.barrier.release('b1');f.barrier.complete();f.advance(100);
  assert.deepEqual(f.sent,['b2','b1']);assert.equal(f.barrier.aborted,false);assert.equal(f.timers.size,0);
});

test('a late participant cannot extend the first frame deadline',()=>{
  const f=fixture();f.hold('b2');f.advance(17);f.hold('b1');assert.equal(f.barrier.remainingMs(),1);f.advance(1);
  assert.equal(f.barrier.aborted,true);assert.equal(f.barrier.sends.size,0);
  assert.deepEqual([...f.barrier.droppedUnforwardedFrames],['b2','b1']);
  assert.throws(()=>f.barrier.release('b2'),/SUBMISSION_BARRIER_EXPIRED/);assert.deepEqual(f.sent,[]);
});

test('a stalled actual-socket identity probe expires without forwarding held bytes',async()=>{
  const f=fixture();f.hold('b2');f.hold('b1');
  const pending=f.barrier.withinWindow(()=>new Promise(()=>{})),rejected=assert.rejects(pending,/SUBMISSION_BARRIER_EXPIRED/);
  f.advance(18);await rejected;assert.deepEqual(f.sent,[]);assert.equal(f.barrier.sends.size,0);assert.equal(f.timers.size,0);
});

test('cross-node delay cannot release the second frame after expiry',async()=>{
  const f=fixture();f.hold('b2');f.hold('b1');f.advance(17);f.barrier.release('b2');
  const pending=f.barrier.withinWindow(()=>new Promise(resolve=>f.setTimer(resolve,2))),rejected=assert.rejects(pending,/SUBMISSION_BARRIER_EXPIRED/);
  f.advance(2);await rejected;assert.throws(()=>f.barrier.release('b1'),/SUBMISSION_BARRIER_EXPIRED/);
  assert.deepEqual(f.sent,['b2']);assert.deepEqual([...f.barrier.droppedUnforwardedFrames],['b1']);
});

test('release checks elapsed time even when timer callbacks were delayed',()=>{
  const f=fixture();f.hold('b1');f.jump(19);
  assert.throws(()=>f.barrier.release('b1'),/SUBMISSION_BARRIER_EXPIRED/);assert.deepEqual(f.sent,[]);assert.equal(f.timers.size,0);
});

test('exception cleanup drops held frames and refuses late additions',()=>{
  const f=fixture();f.hold('b1');f.barrier.abort('CASE_FAILED');assert.equal(f.hold('b2'),false);
  assert.throws(()=>f.barrier.release('b1'),/CASE_FAILED/);assert.deepEqual(f.sent,[]);
  assert.deepEqual([...f.barrier.droppedUnforwardedFrames],['b1','b2']);assert.equal(f.timers.size,0);
});

test('probe failure retains queued bytes for abort and removes its wait timer',async()=>{
  const f=fixture();f.hold('b1');await assert.rejects(f.barrier.withinWindow(()=>Promise.reject(new Error('NODE_PROBE_FAILED'))),/NODE_PROBE_FAILED/);
  assert.equal(f.barrier.sends.size,1);assert.equal(f.timers.size,1);f.barrier.abort('CASE_FAILED');
  assert.deepEqual(f.sent,[]);assert.equal(f.timers.size,0);
});

test('a duplicate role aborts rather than replacing original signed bytes',()=>{
  const f=fixture();f.hold('b1');assert.equal(f.hold('b1'),false);
  assert.equal(f.barrier.abortReason,'DUPLICATE_SUBMISSION_FRAME');assert.equal(f.barrier.sends.size,0);assert.deepEqual(f.sent,[]);
});
