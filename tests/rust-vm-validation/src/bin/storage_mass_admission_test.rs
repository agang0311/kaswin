//! Offline production resource admission search. Not a VM or network PASS.
use kaspa_consensus_core::{config::params::MAINNET_PARAMS,mass::{MassCalculator,ComputeBudget,UtxoPlurality},tx::{Transaction,TransactionInput,TransactionOutput,TransactionOutpoint,ComputeCommit,CovenantBinding,ScriptPublicKey,UtxoEntry,PopulatedTransaction},subnets::SubnetworkId};
use kaspa_hashes::Hash;
use kaspa_txscript::{standard::pay_to_script_hash_script,script_builder::ScriptBuilder,EngineFlags};
#[path="../../../../contracts/v1_constants.rs"] mod v1_constants;
#[path="../../../../contracts/ticket_commitment.rs"] mod ticket_commitment;
#[path="../../../../contracts/refunding_covenant.rs"] mod refunding_covenant;
use refunding_covenant::*;
#[path="../../../../contracts/winner_ready_settlement.rs"] mod winner_ready_settlement;
#[path="../../../../contracts/winner_selection.rs"] mod winner_selection;
#[path="../../../../contracts/sealed_covenant.rs"] mod sealed_covenant;
#[path="../../../../contracts/open_covenant.rs"] mod open_covenant;
#[path="../../../../contracts/genesis.rs"] mod genesis;
const C:u64=1_000_000_000_000;
fn raw()->Vec<u8>{let mut s=vec![0x20];s.extend([0x11;32]);s.push(0xac);s}
fn output(value:u64,cov:bool,script:ScriptPublicKey)->TransactionOutput{TransactionOutput{value,script_public_key:script,covenant:cov.then_some(CovenantBinding{covenant_id:Hash::from_u64_word(7),authorizing_input:0})}}
#[derive(Clone,Debug)]struct Row{p:usize,cursor:usize,k:usize,storage:u64,compute:u64,transient:u64,relay:u64,harmonic:u64,subtraction:u64,ip:u64,sp:u64,fee:u64,parts:Vec<u64>}
fn refund(g:u64,d:u64,p:usize,cursor:usize,mode:u8)->Option<Row>{
 refund_inner(g,d,p,cursor,mode,false)
}
fn refund_inner(g:u64,d:u64,p:usize,cursor:usize,mode:u8,verify_vm:bool)->Option<Row>{
 let calc=MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
 let k=schedule_next_k(p-cursor,p,16); let terminal=cursor+k==p;
 let mut dir=Vec::new();for i in 0..p {dir.extend(((i+1)as u32).to_le_bytes());dir.extend([0x11;32]);}
 let redeem=build_compact_universal_refunding_covenant(Hash::from_u64_word(1),g,p as u64,cursor as u64,raw(),dir.clone());
 let entry=UtxoEntry::new(d+g*(p-cursor)as u64,pay_to_script_hash_script(&redeem),1_000_000,false,Some(Hash::from_u64_word(7)));
 let mut outs=Vec::new();if !terminal{let next=build_compact_universal_refunding_covenant(Hash::from_u64_word(1),g,p as u64,(cursor+k)as u64,raw(),dir);outs.push(output(d+g*(p-cursor-k)as u64,true,pay_to_script_hash_script(&next)));}
 for _ in 0..k{outs.push(output(g,false,ScriptPublicKey::from_vec(0,raw())));}
 if terminal{outs.push(output(d,false,ScriptPublicKey::from_vec(0,raw())));}
 let mut sb=ScriptBuilder::with_flags(EngineFlags{covenants_enabled:true,..Default::default()});for _ in 0..k{sb.add_data(&0u64.to_le_bytes()).unwrap();}sb.add_i64(k as i64).unwrap();sb.add_data(&redeem).unwrap();
 let mut tx=Transaction::new(1,vec![TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(8),0),sb.drain(),0,ComputeCommit::ComputeBudget(ComputeBudget(40)))],outs,0,SubnetworkId::default(),0,vec![]);
 let m=calc.calc_non_contextual_masses(&tx);let relay=m.compute_mass.max(m.normalized_transient(&MAINNET_PARAMS.block_mass_cofactors().after()))*100;
 let total_fee=if mode==0{0}else{relay};let mut fees=vec![0;k];let mut left=total_fee;
 for j in 0..k{fees[j]=if mode==2{left.min(1_500_000)}else{total_fee/k as u64+u64::from((j as u64)<total_fee%k as u64)};left=left.saturating_sub(fees[j]);if fees[j]>1_500_000||g<fees[j]+10_000{return None;}tx.outputs[j+usize::from(!terminal)].value=g-fees[j];}if left>0{return None;}
 let mut final_sb=ScriptBuilder::with_flags(EngineFlags{covenants_enabled:true,..Default::default()});for fee in fees.iter().rev(){final_sb.add_data(&fee.to_le_bytes()).unwrap();}final_sb.add_i64(k as i64).unwrap();final_sb.add_data(&redeem).unwrap();tx.inputs[0].signature_script=final_sb.drain();tx.finalize();
 let parts:Vec<u64>=tx.outputs.iter().map(|o|C*o.plurality()*o.plurality()/o.value).collect();let harmonic=parts.iter().sum::<u64>();let ip=entry.plurality();let sp=if terminal{0}else{tx.outputs[0].plurality()};
 let pop=PopulatedTransaction::new(&tx,vec![entry]);let storage=calc.calc_contextual_masses(&pop)?.storage_mass;
 if verify_vm {
  let cache=kaspa_txscript::caches::Cache::new(10);
  let reused=kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync::new();
  let cov=kaspa_txscript::covenants::CovenantsContext::from_tx(&pop).unwrap();
  let ctx=kaspa_txscript::EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
  let flags=EngineFlags{covenants_enabled:true,sigop_script_units:kaspa_consensus_core::mass::Gram(1000).into()};
  let mut vm=kaspa_txscript::TxScriptEngine::from_transaction_input_with_script_units_limit(&pop,&tx.inputs[0],0,&pop.entries[0],ctx,flags,tx.inputs[0].compute_commit.allowed_script_units());
  assert_eq!(vm.execute(),Ok(()),"candidate committed VM P={p} cursor={cursor}");
  assert!(total_fee>=relay);assert!(storage<=400_000);assert!(m.compute_mass<=500_000&&m.transient_mass<=1_000_000);
 }

 Some(Row{p,cursor,k,storage,compute:m.compute_mass,transient:m.transient_mass,relay,harmonic,subtraction:harmonic.saturating_sub(storage),ip,sp,fee:total_fee,parts})
}
fn worst(g:u64,d:u64)->Option<Row>{let mut best=None;for p in [1,17,256]{let mut cursor=0;while cursor<p{let r=refund(g,d,p,cursor,1)?;cursor+=r.k;if best.as_ref().map_or(true,|b:&Row|r.storage>b.storage){best=Some(r);}}}best}
fn main(){
 println!("PIN cfafeb4c093fa37a303f1b9f19c58f986b870ce3; OFFLINE MASS ONLY; production body, budget40 conservative; no admission PASS");
 for p in [1,17,256]{let r=refund(1_510_000,50_000_000,p,0,0).unwrap();println!("OLD_MIN fee0 {:?}",r);assert!(r.storage>500_000);}
 for d in [1,10_000,100_000,500_000,1_000_000,2_000_000,5_000_000,10_000_000,20_000_000,50_000_000,100_000_000]{for g in [2_000_000,5_000_000,10_000_000,20_000_000,30_000_000,40_000_000,50_000_000,75_000_000,100_000_000,200_000_000]{if let Some(r)=worst(g,d){println!("GRID gross={g} deposit={d} P={} cursor={} k={} storage={} headroom={} compute={} transient={} relay={}",r.p,r.cursor,r.k,r.storage,500_000i64-r.storage as i64,r.compute,r.transient,r.relay);}}}
 for d in [5_000_000,10_000_000,20_000_000,50_000_000]{for target in [500_000,400_000]{let(mut lo,mut hi)=(1_510_000,200_000_000);while lo<hi{let mid=lo+(hi-lo)/2;if worst(mid,d).map_or(false,|r|r.storage<=target){hi=mid}else{lo=mid+1}}println!("BOUND deposit={d} target={target} gross={lo} worst={:?}",worst(lo,d));}}
 for target in [500_000,400_000]{let(mut lo,mut hi)=(1,100_000_000);while lo<hi{let mid=lo+(hi-lo)/2;if worst(100_000_000,mid).map_or(false,|r|r.storage<=target){hi=mid}else{lo=mid+1}}println!("DEPOSIT_BOUND gross=100000000 target={target} deposit={lo} worst={:?}",worst(100_000_000,lo));}
 for cursor in [0,240]{println!("OLD_P256 {:?}",refund(6_000_000,50_000_000,256,cursor,1));}
 for p in [1,17,256]{let mut cur=0;while cur<p{let r=refund_inner(100_000_000,5_000_000,p,cur,1,true).unwrap();println!("CANDIDATE {:?}",r);cur+=r.k;}}
 println!("CONCENTRATED {:?}",refund(50_000_000,20_000_000,256,0,2));
 // Terminal output amounts at the successful minimum economic boundary.
 // These rows prove mass only, not that the state/witness executes in VM.
 let calc=MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
 for d in [1,10_000,100_000,500_000,1_000_000,2_000_000,5_000_000,10_000_000,20_000_000,50_000_000,100_000_000]{
  let spk=pay_to_script_hash_script(&[0x51]);
  let entry=UtxoEntry::new(250_000_000+d,spk,1_000_000,false,Some(Hash::from_u64_word(7)));
  let tx=Transaction::new(1,vec![TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(8),0),vec![],0,ComputeCommit::ComputeBudget(ComputeBudget(0)))],vec![output(100_000_000,false,ScriptPublicKey::from_vec(0,raw())),output(d,false,ScriptPublicKey::from_vec(0,raw())),output(100_000_000,false,ScriptPublicKey::from_vec(0,raw()))],0,SubnetworkId::default(),0,vec![]);
  println!("PAID_MASS_ONLY deposit={d} storage={} creator_plurality={}",calc.calc_contextual_masses(&PopulatedTransaction::new(&tx,vec![entry])).unwrap().storage_mass,tx.outputs[1].plurality());
 }
 terminals();
 println!("1 KAS STORAGE ADMISSION: production refund and terminal boundary checks PASS (not full lifecycle)");
}

fn terminals(){
 use v1_constants::*;
 let mut full=vec![0,0];full.extend(raw());
 for (price,dep,ok) in [(MIN_TICKET_PRICE_V1-1,MIN_STATE_DEPOSIT_V1,false),(MIN_TICKET_PRICE_V1,MIN_STATE_DEPOSIT_V1-1,false),(MIN_TICKET_PRICE_V1,MIN_STATE_DEPOSIT_V1,true)]{
  assert_eq!(genesis::validate_directory_create_parameters(price,1000,3,2_000_000,&full,dep).is_ok(),ok);
 }
 let d=MIN_STATE_DEPOSIT_V1;let flags=EngineFlags{covenants_enabled:true,sigop_script_units:kaspa_consensus_core::mass::Gram(1000).into()};
 let calc=MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
 for empty in [false,true]{
  let kp=secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1,&[0x34;32]).unwrap();
  let mut sponsor=vec![0x20];sponsor.extend(kp.x_only_public_key().0.serialize());sponsor.push(0xac);
  let redeem=if empty{open_covenant::build_directory_open_covenant(Hash::from_u64_word(1),MIN_TICKET_PRICE_V1,1000,3,2_000_000,0,0,ticket_commitment::compute_empty_root_27(),raw(),&[]).unwrap()}else{winner_ready_settlement::build_production_winner_ready_3out_covenant(Hash::from_u64_word(1),MIN_TICKET_PRICE_V1,3,Hash::from_u64_word(2),Hash::from_u64_word(3),Hash::from_u64_word(4),0,0,raw(),raw())};
  let mut sb=ScriptBuilder::with_flags(flags);if empty{sb.add_i64(open_covenant::ACTION_CLOSE).unwrap();}else{sb.add_data(&raw()).unwrap();}sb.add_data(&redeem).unwrap();
  let amount=if empty{d}else{d+300_000_000};
  let mut entries=vec![UtxoEntry::new(amount,pay_to_script_hash_script(&redeem),1_000_000,false,Some(Hash::from_u64_word(7)))];
  let mut ins=vec![TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(8),0),sb.drain(),0,ComputeCommit::ComputeBudget(ComputeBudget(10)))];
  let outs=if empty{entries.push(UtxoEntry::new(100_000_000,ScriptPublicKey::from_vec(0,sponsor.clone()),1_000_000,false,None));ins.push(TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(9),0),vec![0;66],0,ComputeCommit::ComputeBudget(ComputeBudget(10))));vec![output(d,false,ScriptPublicKey::from_vec(0,raw())),output(90_000_000,false,ScriptPublicKey::from_vec(0,sponsor.clone()))]}else{vec![output(150_000_000,false,ScriptPublicKey::from_vec(0,raw())),output(d,false,ScriptPublicKey::from_vec(0,raw())),output(100_000_000,false,ScriptPublicKey::from_vec(0,raw()))]};
  let mut tx=Transaction::new(1,ins,outs,if empty{2_000_000}else{0},SubnetworkId::default(),0,vec![]);
  if empty{let pop=PopulatedTransaction::new(&tx,entries.clone());let reused=kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync::new();let h=kaspa_consensus_core::hashing::sighash::calc_schnorr_signature_hash(&pop,1,kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL,&reused);let sig=kp.sign_schnorr(secp256k1::Message::from_digest_slice(&h.as_bytes()).unwrap());let mut s=vec![65];s.extend(sig.as_ref());s.push(1);tx.inputs[1].signature_script=s;}
  tx.finalize();let pop=PopulatedTransaction::new(&tx,entries);let cov=kaspa_txscript::covenants::CovenantsContext::from_tx(&pop).unwrap();let cache=kaspa_txscript::caches::Cache::new(10);let reused=kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync::new();let ctx=kaspa_txscript::EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
  for i in 0..tx.inputs.len(){let mut vm=kaspa_txscript::TxScriptEngine::from_transaction_input_with_script_units_limit(&pop,&tx.inputs[i],i,&pop.entries[i],ctx,flags,tx.inputs[i].compute_commit.allowed_script_units());assert_eq!(vm.execute(),Ok(()),"terminal empty={empty} input={i}");}
  let mass=calc.calc_contextual_masses(&pop).unwrap().storage_mass;let m=calc.calc_non_contextual_masses(&tx);let relay=m.compute_mass.max(m.normalized_transient(&MAINNET_PARAMS.block_mass_cofactors().after()))*100;let input_sum=pop.entries.iter().map(|e|e.amount).sum::<u64>();let output_sum=tx.outputs.iter().map(|o|o.value).sum::<u64>();let fee=input_sum.checked_sub(output_sum).unwrap();assert!(fee>=relay);assert!(mass<=400_000);assert_eq!(tx.outputs[if empty{0}else{1}].value,d);assert!(tx.outputs.iter().all(|o|o.covenant.is_none()));println!("TERMINAL empty={empty} deposit={d} storage={mass} fee={fee} relay={relay} ALL_INPUTS_COMMITTED_PASS");
 }
}
