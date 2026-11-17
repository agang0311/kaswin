/** Read-only bridge to existing selected-chain acceptance, with a fresh 100-DAA observation.
 * This depth is client policy, not irreversible finality.
 * Host supplies an identity-checked link; importing performs no RPC or node launch.
 */
import {AcceptanceEvidence} from '../../scripts/chain/acceptance-evidence.mjs';
import {parseSpk} from '../../scripts/chain/nodes.mjs';
import {linkNet} from '../../scripts/chain/network-schema.mjs';
import {observeAcceptanceRead} from '../../scripts/chain/acceptance-read.mjs';
import {decodeSpend} from '../../scripts/rolling/core.mjs';
import {check,hex,unhex,ZERO} from '../../scripts/rolling/core.mjs';
export class RollingNodeAdapter {
  constructor({link,profile,archive}) {
    this.link=link;this.profile=profile;this.archive=archive;this.network=linkNet(link).genesis;
    this.evidence=new AcceptanceEvidence({link,profileId:profile.id});
  }
  async authenticateAccepted(txid,position) {
    const accepting=position?.acceptingBlockHash;unhex(txid,32);unhex(accepting,32);
    const proof=await this.evidence.read(txid,accepting,{fresh:true}),ev=proof.ev;
    try {
      check(proof.virtualDaa>=ev.acceptingDaa+100n,'ACCEPTANCE_DEPTH_PENDING');
      check(ev.inputs.length===ev.tx.inputs.length&&ev.inputs.every(Boolean),'MISSING_ACCEPTED_INPUT_CONTEXT');
      const inputs=ev.inputs.map((u,i)=>({outpoint:ev.tx.inputs[i].previousOutpoint,value:u.value,
        spk:typeof u.spk==='string'?parseSpk(u.spk):u.spk,utxoDaa:u.daa,cid:u.covenantId??null}));
      const facts={accepted:true,networkGenesis:this.network,transaction:ev.tx,utxoDaa:ev.acceptingDaa,
        currentDaa:ev.acceptingDaa,observedVirtualDaa:proof.virtualDaa,position:{acceptingBlockHash:accepting},
        assertCurrent:()=>proof.scope.check(accepting),release:()=>proof.scope.close()};
      if(!inputs[0].cid||inputs[0].cid===ZERO){facts.funds=inputs;return facts;}
      const own=decodeSpend(ev.tx.inputs[0].signatureScript,this.profile),cid=inputs[0].cid;
      let origin;
      if(own.state.module==='sales')origin={transactionId:hex(own.args.originTxId),index:Number(own.args.originIndex)};
      else {
        const round=await this.archive.getRound(this.network,this.profile.id,cid);
        check(round?.origin,'ORIGIN_ARCHIVE_REQUIRED');origin=round.origin;
      }
      facts.manager={...inputs[0],origin,currentDaa:ev.acceptingDaa,redeemScript:own.raw};facts.targets=[];facts.funds=[];
      let funding=false;
      for(let i=1;i<inputs.length;i++) {
        const u=inputs[i];
        if(u.cid&&u.cid!==ZERO) {
          check(!funding&&u.cid===cid,'TARGET_LAYOUT');const w=decodeSpend(ev.tx.inputs[i].signatureScript,this.profile);
          check(w.state.module==='frozen','TARGET_ROLE');facts.targets.push({...u,redeemScript:w.raw});
        } else {funding=true;facts.funds.push(u);}
      }
      if(own.state.module==='sealed'&&own.args.action===4n) {
        check(own.args.data.length>=240,'DRAW_DATA');const hash=hex(own.args.data.slice(0,32));
        const result=await this.link.call('getBlock',{hash,includeTransactions:false});
        const b=result?.block;check(b?.header?.hash===hash&&b.verboseData?.isChainBlock===true,'DRAW_TARGET_NOT_CHAIN');
        unhex(b.header.acceptedIdMerkleRoot,32);
        facts.accessor={blockHash:hash,sequenceCommitment:b.header.acceptedIdMerkleRoot};
      }
      facts.assertCurrent();return facts;
    } catch(e) {proof.scope.close();throw e;}
  }
  async authenticateReversal(position) {
    const hash=position?.acceptingBlockHash;unhex(hash,32);
    const run=async link=>{
      const scope=await observeAcceptanceRead(link,this.link);
      try {
        const b=(await link.call('getBlock',{hash,includeTransactions:false}))?.block;
        scope.check('');check(b?.header?.hash===hash,'REVERSAL_BLOCK_MISSING');
        check(b.verboseData?.isChainBlock===false,'REVERSAL_NOT_PROVEN');
        return {removed:true,networkGenesis:this.network};
      } finally {scope.close();}
    };
    return this.link.pinned?this.link.pinned(run,{retries:0}):run(this.link);
  }
  dispose() {this.evidence.dispose();}
}
