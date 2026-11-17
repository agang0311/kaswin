// Test-only transport barrier. The first held frame starts one shared deadline;
// identity probes and delayed releases consume that same window.
export class SubmissionBarrier {
  constructor({windowMs=18000,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}) {
    if(!Number.isSafeInteger(windowMs)||windowMs<=0||windowMs>=30000)throw new Error('SUBMISSION_BARRIER_WINDOW');
    Object.assign(this,{windowMs,now,setTimer,clearTimer});
    this.enabled=false;this.aborted=false;this.allowedRole=null;this.lateDropped={};
    this.sends=new Map();this.droppedUnforwardedFrames=new Set();this.deadline=null;this.timer=null;this.abortReason=null;
  }
  remainingMs(){return this.deadline===null?Infinity:Math.max(0,this.deadline-this.now());}
  expired(){return this.aborted||this.remainingMs()===0;}
  hold(role,send) {
    if(this.expired()){this.droppedUnforwardedFrames.add(role);this.abort(this.abortReason??'SUBMISSION_BARRIER_EXPIRED');return false;}
    if(this.sends.has(role)){this.abort('DUPLICATE_SUBMISSION_FRAME');this.droppedUnforwardedFrames.add(role);return false;}
    const at=this.now();
    if(this.deadline===null){
      this.deadline=at+this.windowMs;
      this.timer=this.setTimer(()=>this.abort('SUBMISSION_BARRIER_EXPIRED'),this.windowMs);
      this.timer?.unref?.();
    }
    this.sends.set(role,{send,at});return true;
  }
  assertOpen() {
    if(this.expired()){
      this.abort(this.abortReason??'SUBMISSION_BARRIER_EXPIRED');
      throw new Error(this.abortReason);
    }
  }
  async withinWindow(work) {
    let timer;
    try {
      this.assertOpen();
      if(this.deadline===null)throw new Error('SUBMISSION_BARRIER_NOT_STARTED');
      const timeout=new Promise((_,reject)=>{
        timer=this.setTimer(()=>{this.abort('SUBMISSION_BARRIER_EXPIRED');reject(new Error(this.abortReason));},this.remainingMs());
        timer?.unref?.();
      });
      const result=await Promise.race([work(),timeout]);
      this.assertOpen();return result;
    }finally{if(timer!==undefined)this.clearTimer(timer);}
  }
  release(role) {
    this.assertOpen();const frame=this.sends.get(role);
    if(!frame)throw new Error(`SUBMISSION_FRAME_MISSING ${role}`);
    this.sends.delete(role);frame.send();
  }
  complete() {
    if(this.sends.size)throw new Error('SUBMISSION_FRAMES_STILL_HELD');
    if(this.timer!==null)this.clearTimer(this.timer);
    this.timer=null;this.enabled=false;
  }
  abort(reason='SUBMISSION_BARRIER_ABORTED') {
    for(const role of this.sends.keys())this.droppedUnforwardedFrames.add(role);
    this.sends.clear();this.aborted=true;this.enabled=false;this.abortReason??=reason;
    if(this.timer!==null)this.clearTimer(this.timer);
    this.timer=null;
  }
}
