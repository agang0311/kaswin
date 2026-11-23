/** Rolling v1 ProtocolAdapter implementation.
 * Wraps the existing Rolling v1 state machine, transaction builder, intent verifier, and catch-up logic
 * behind the multi-covenant ProtocolAdapter interface without changing any Rolling v1 wire/consensus semantics. */
import {check,verifyManager} from '../core.mjs';
import {kasAsset} from './registry.mjs';
import {emptyRound,validateRound,roundFromText,roundToText,availableActions,advanceRound,describeRound} from '../round/round.mjs';
import {prepareOperation,signAndRecord,liveRound} from '../round/prepare.mjs';
import {authenticateIntent,submitIntent} from '../tracking/intent.mjs';
import {verifyIndexedSnapshot,materializeIndexedDocument} from '../round/indexer-client.mjs';
import {syncRoundThreeTier,discoverRestRollingRounds} from '../round/catchup.mjs';

/** Map a Rolling v1 round into the protocol-agnostic summary used by shared list/detail/progress views. */
export function rollingV1Summary(round,{profile,net=null}={}) {
  const asset=kasAsset(net);
  let phase='OPEN',subPhase='sales',settlementProgress=null;
  if(round.terminal==='PAID'||round.terminal==='EMPTY') {
    phase='DONE';subPhase=round.terminal;
  } else if(round.terminal==='REFUNDED') {
    phase='DONE';subPhase='REFUNDED';
  } else if(round.manager) {
    let mod=null,state=null;
    try {state=verifyManager({...round.manager,currentDaa:round.manager.utxoDaa},profile);mod=state.module;} catch {}
    subPhase=mod??'unknown';
    if(mod==='sales') phase='OPEN';
    else if(mod==='sealed') phase='SEALED';
    else if(mod==='win') {
      phase='SETTLING';
      const remaining=(round.frozen?.length??0)+1;
      const paid=round.receipts?.filter(rc=>rc.action==='PAY_OLD'||rc.action==='PAY_SELF').length??0;
      settlementProgress={done:paid,total:paid+remaining,labelKey:'PAYOUT'};
    } else if(mod==='refund') {
      phase='REFUNDING';
      const remaining=(round.frozen?.length??0)+1;
      const refunded=round.receipts?.filter(rc=>rc.action==='REFUND_OLD'||rc.action==='REFUND_SELF').length??0;
      settlementProgress={done:refunded,total:refunded+remaining,labelKey:'REFUND'};
    }
  }
  return {
    protocolId:'rolling-v1',
    profileId:round.profileId??profile.id,
    roundId:round.cid,
    asset,
    phase,
    subPhase,
    terminal:round.terminal??null,
    ticketsSold:round.bought??0,
    ticketCap:round.settings?.ticketCap??0,
    ticketPrice:round.settings?.ticketPrice??0n,
    settlementProgress,
  };
}

export function createRollingV1Adapter({profile,canCreate=true}={}) {
  check(profile&&typeof profile.id==='string','ROLLING_V1_PROFILE');
  const profileId=profile.id;
  return Object.freeze({
    id:'rolling-v1',
    name:'Rolling v1',
    profileId,
    profile,
    capabilities:Object.freeze({
      canCreate:!!canCreate,
      multiShardSelect:false,
      pullRefund:false,
      supportsExecIncentive:false,
      supportsBudgetCalculator:true,
    }),
    assetFor(net=null){return kasAsset(net);},
    emptyRound(args){return emptyRound({...args,profileId});},
    validateRound(r,opts={}){return validateRound(r,profile,{...opts,profileId});},
    roundFromText(text,opts={}){return roundFromText(text,profile,{...opts,profileId});},
    roundToText(r,opts={}){return roundToText(r,profile,{...opts,profileId});},
    availableActions(r,currentDaa){return availableActions(r,profile,currentDaa);},
    advanceRound(r,accepted,tx,accessor){return advanceRound(r,accepted,tx,profile,accessor);},
    describeRound(r,currentDaa){return describeRound(r,profile,currentDaa);},
    liveRound(rpc,r,opts={}){return liveRound(rpc,r,profile,opts);},
    prepareOperation(args){return prepareOperation({...args,profile});},
    signAndRecord(args){return signAndRecord({...args,profile});},
    authenticateIntent(intent,opts={}){return authenticateIntent(intent,profile,{...opts,profileId});},
    submitIntent(rpc,intent,opts={}){return submitIntent(rpc,intent,profile,opts);},
    verifyIndexedSnapshot(doc,rpc,opts={}){return verifyIndexedSnapshot(doc,rpc,profile,{...opts,profileId});},
    materializeIndexedDocument(doc,opts={}){return materializeIndexedDocument(doc,profile,opts);},
    syncRound(args){return syncRoundThreeTier({...args,profile});},
    discoverRestRounds(args){return discoverRestRollingRounds({...args,profile});},
    toRoundSummary(r,opts={}){return rollingV1Summary(r,{...opts,profile});},
  });
}
