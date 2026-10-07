// Included by the production E2E binary, not a standalone test target.
// Every state entry below is obtained from the predecessor transaction output.
fn connected_refund_round(p: usize) {
    let price = MIN_TICKET_PRICE_V1;
    let deposit = MIN_STATE_DEPOSIT_V1;
    let cap = (p as u64 + 2).max(4);
    let min = (p as u64 + 1).max(3);
    let deadline = 2_000_000;
    let key = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x61;32]).unwrap();
    let mut payout = vec![0x20]; payout.extend(key.x_only_public_key().0.serialize()); payout.push(0xac);
    let mut full_payout = vec![0,0]; full_payout.extend(&payout);
    let funding = TransactionOutpoint::new(Hash::from_u64_word(0x9000 + p as u64),0);
    let round = compute_canonical_round_id(&funding);
    let (genesis, c) = build_directory_genesis_output(funding,price,cap,min,deadline,full_payout,deposit).unwrap();
    let calc = MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
    let cofactors = MAINNET_PARAMS.block_mass_cofactors().after();
    let flags = EngineFlags { covenants_enabled:true,sigop_script_units:kaspa_consensus_core::mass::Gram(1000).into() };
    let cache = Cache::new(100);
    let initial_entry = UtxoEntry::new(deposit+100_000_000,ScriptPublicKey::from_vec(0,payout.clone()),1_000_000,false,None);
    let ordinary = |value| TransactionOutput {value,script_public_key:ScriptPublicKey::from_vec(0,payout.clone()),covenant:None};
    let mut prev = Transaction::new(1,vec![TransactionInput::new_with_mass(funding,vec![],0,ComputeCommit::ComputeBudget(ComputeBudget(10)))],vec![genesis,ordinary(90_000_000)],0,SubnetworkId::default(),0,vec![]);
    sign_p2pk_input(&mut prev,0,&key,&[initial_entry.clone()]);
    {
        let pop=PopulatedTransaction::new(&prev,vec![initial_entry]);let cov=CovenantsContext::from_tx(&pop).unwrap();let reused=SigHashReusedValuesUnsync::new();let ctx=EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
        measure_and_verify_transition("REFUND ROUND CREATE",0,&pop,0,ctx,flags,&calc,&cofactors);
    }
    let mut redeem=build_initial_directory_open_covenant(round,price,cap,min,deadline,payout.clone()).unwrap();
    let mut directory=Vec::new();
    let mut leaves=HashMap::<u64,Hash>::new();
    let empties=compute_empty_levels();
    let mut root=compute_empty_root_27();
    // Sparse frontier: never materialize absent 2^27 leaves.
    for index in 0..p {
        let mut layer=leaves.clone();let mut siblings=[Hash::default();ticket_commitment::TREE_DEPTH];
        for level in 0..ticket_commitment::TREE_DEPTH {
            siblings[level]=*layer.get(&(((index as u64)>>level)^1)).unwrap_or(&empties[level]);
            let mut parents=HashMap::new();
            for node in layer.keys() {
                let parent=*node/2;
                if !parents.contains_key(&parent) {parents.insert(parent,hash_internal_node(layer.get(&(parent*2)).unwrap_or(&empties[level]),layer.get(&(parent*2+1)).unwrap_or(&empties[level])));}
            }
            layer=parents;
        }
        assert_eq!(compute_root_from_path(&compute_empty_leaf(),index as u64,&siblings),root);
        let leaf=compute_purchase_leaf(&round,index as u64,index as u64,1,&compute_payout_commitment(&payout));
        root=compute_root_from_path(&leaf,index as u64,&siblings);leaves.insert(index as u64,leaf);
        directory.extend(((index+1)as u32).to_le_bytes());directory.extend(key.x_only_public_key().0.serialize());
        let next_redeem=build_directory_open_covenant(round,price,cap,min,deadline,index as u64+1,index as u64+1,root,payout.clone(),&directory).unwrap();
        let state=&prev.outputs[0];assert_eq!(state.script_public_key,pay_to_script_hash_script(&redeem));assert_eq!(state.covenant.as_ref().unwrap().covenant_id,c);
        let entry=UtxoEntry::new(state.value,state.script_public_key.clone(),1_000_000,false,Some(c));
        let fee_entry=UtxoEntry::new(price+100_000_000,ScriptPublicKey::from_vec(0,payout.clone()),1_000_000,false,None);
        let mut sb=ScriptBuilder::with_flags(flags);for s in siblings.iter().rev(){sb.add_data(&s.as_bytes()).unwrap();}sb.add_data(&payout).unwrap();sb.add_data(&1u64.to_le_bytes()).unwrap();sb.add_i64(ACTION_BUY).unwrap();sb.add_data(&redeem).unwrap();
        let mut tx=Transaction::new(1,vec![TransactionInput::new_with_mass(TransactionOutpoint::new(prev.id(),0),sb.drain(),0,ComputeCommit::ComputeBudget(ComputeBudget(40))),TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(0x100000+p as u64*1000+index as u64),0),vec![],0,ComputeCommit::ComputeBudget(ComputeBudget(10)))],vec![TransactionOutput{value:state.value+price,script_public_key:pay_to_script_hash_script(&next_redeem),covenant:Some(CovenantBinding{covenant_id:c,authorizing_input:0})},ordinary(90_000_000)],0,SubnetworkId::default(),0,vec![]);
        sign_p2pk_input(&mut tx,1,&key,&[entry.clone(),fee_entry.clone()]);
        {let pop=PopulatedTransaction::new(&tx,vec![entry,fee_entry]);let cov=CovenantsContext::from_tx(&pop).unwrap();let reused=SigHashReusedValuesUnsync::new();let ctx=EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);measure_and_verify_transition("CONNECTED REFUND BUY",redeem.len(),&pop,0,ctx,flags,&calc,&cofactors);}
        prev=tx;redeem=next_redeem;
    }
    let refund_redeem=if p>0 {build_compact_universal_refunding_covenant(round,price,p as u64,0,payout.clone(),directory.clone())}else{Vec::new()};
    let state=prev.outputs[0].clone();assert_eq!(state.script_public_key,pay_to_script_hash_script(&redeem));
    let entry=UtxoEntry::new(state.value,state.script_public_key.clone(),1_000_000,false,Some(c));
    let fee_entry=UtxoEntry::new(100_000_000,ScriptPublicKey::from_vec(0,payout.clone()),1_000_000,false,None);
    let mut sb=ScriptBuilder::with_flags(flags);sb.add_i64(ACTION_CLOSE).unwrap();sb.add_data(&redeem).unwrap();
    let close_output=if p==0{ordinary(deposit)}else{TransactionOutput{value:state.value,script_public_key:pay_to_script_hash_script(&refund_redeem),covenant:Some(CovenantBinding{covenant_id:c,authorizing_input:0})}};
    let mut close=Transaction::new(1,vec![TransactionInput::new_with_mass(TransactionOutpoint::new(prev.id(),0),sb.drain(),0,ComputeCommit::ComputeBudget(ComputeBudget(40))),TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(0x200000+p as u64),0),vec![],0,ComputeCommit::ComputeBudget(ComputeBudget(10)))],vec![close_output,ordinary(90_000_000)],deadline,SubnetworkId::default(),0,vec![]);
    sign_p2pk_input(&mut close,1,&key,&[entry.clone(),fee_entry.clone()]);
    {let pop=PopulatedTransaction::new(&close,vec![entry,fee_entry]);let cov=CovenantsContext::from_tx(&pop).unwrap();let reused=SigHashReusedValuesUnsync::new();let ctx=EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);measure_and_verify_transition("CONNECTED REFUND CLOSE",redeem.len(),&pop,0,ctx,flags,&calc,&cofactors);}
    prev=close;redeem=refund_redeem;
    let mut cursor=0;let mut batches=Vec::new();
    while cursor<p {
        let k=schedule_next_k(p-cursor,p,REFUND_K_MAX_V1);batches.push(k);let terminal=cursor+k==p;
        let state=prev.outputs[0].clone();assert_eq!(state.script_public_key,pay_to_script_hash_script(&redeem));assert_eq!(state.value,deposit+(p-cursor)as u64*price);
        let entry=UtxoEntry::new(state.value,state.script_public_key.clone(),1_000_000,false,Some(c));
        let next=if terminal{Vec::new()}else{build_compact_universal_refunding_covenant(round,price,p as u64,(cursor+k)as u64,payout.clone(),directory.clone())};
        let mut outs=Vec::new();if !terminal{outs.push(TransactionOutput{value:state.value-k as u64*price,script_public_key:pay_to_script_hash_script(&next),covenant:Some(CovenantBinding{covenant_id:c,authorizing_input:0})});}
        for _ in 0..k{outs.push(ordinary(price));}if terminal{outs.push(ordinary(deposit));}
        let mut sb=ScriptBuilder::with_flags(flags);for _ in 0..k{sb.add_data(&0u64.to_le_bytes()).unwrap();}sb.add_i64(k as i64).unwrap();sb.add_data(&redeem).unwrap();
        let mut tx=Transaction::new(1,vec![TransactionInput::new_with_mass(TransactionOutpoint::new(prev.id(),0),sb.drain(),0,ComputeCommit::ComputeBudget(ComputeBudget(40)))],outs,0,SubnetworkId::default(),0,vec![]);
        let masses=calc.calc_non_contextual_masses(&tx);let fee=masses.compute_mass.max(masses.normalized_transient(&cofactors))*100;
        let fees:Vec<_>=(0..k).map(|j|fee/k as u64+u64::from((j as u64)<fee%k as u64)).collect();
        let mut sb=ScriptBuilder::with_flags(flags);for f in fees.iter().rev(){assert!(*f<=MAX_REFUND_FEE_V1);sb.add_data(&f.to_le_bytes()).unwrap();}sb.add_i64(k as i64).unwrap();sb.add_data(&redeem).unwrap();tx.inputs[0].signature_script=sb.drain();
        for j in 0..k{tx.outputs[j+usize::from(!terminal)].value=price-fees[j];assert!(price-fees[j]>=MIN_REFUND_PAYOUT_V1);}
        tx.finalize();
        {let pop=PopulatedTransaction::new(&tx,vec![entry]);let cov=CovenantsContext::from_tx(&pop).unwrap();let reused=SigHashReusedValuesUnsync::new();let ctx=EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);let (r,_)=measure_and_verify_transition("CONNECTED REFUND BATCH",redeem.len(),&pop,0,ctx,flags,&calc,&cofactors);println!("connected P={p} cursor={cursor} k={k} storage={} fee={} floor={}",r.storage_mass,r.actual_fee,r.relay_floor);}
        if terminal{assert_eq!(tx.outputs[k].value,deposit);assert!(tx.outputs.iter().all(|o|o.covenant.is_none()));}
        cursor+=k;prev=tx;redeem=next;
    }
    if p==17{assert_eq!(batches,vec![9,8]);}if p==256{assert_eq!(batches,vec![16;16]);}
    if p==0{assert_eq!(prev.outputs[0].value,deposit);assert!(prev.outputs.iter().all(|o|o.covenant.is_none()));}
    println!("CANONICAL CREATE -> {p} BUY -> CLOSE -> {batches:?} REFUND/EMPTY PASS");
}
