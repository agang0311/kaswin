    // Shared constants and stack-conscious helpers for Kaswin kUSDT v2 (256 parallel shards).
    // SilverScript 1.0.1 inlines every function and retains locals until the enclosing block ends (244-item stack limit).
    // Call multi-local helpers inside dedicated `{ }` blocks and avoid helper calls inside unrolled loops.
    // U16/U32/U63 are stack-neutral source macros expanded by prepare-sources.mjs.
    byte[32] constant ZERO = byte[32](0x0000000000000000000000000000000000000000000000000000000000000000);
    byte[32] constant KUSDT_CID = byte[32](0x{{KUSDT_CID}});
    byte[32] constant KCC20_EXT_TEMPLATE_HASH = byte[32](0x734850b0af0aeef49f009167bf9ddd238fd8c5cdbe214234f97181ac6f5cc498);
    byte[] constant KCC20_PREFIX = byte[](0x6b209703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7);
    int constant KCC20_SUFFIX_LEN = 3885;

    int constant MANAGER_DEPOSIT = 400000000;
    int constant SHARD_LEDGER_DEPOSIT = 200000000;
    int constant SHARD_VAULT_DEPOSIT = 200000000;
    int constant SHARD_TOTAL_DEPOSIT = 400000000;
    int constant WINNER_CARRIER_MIN = 150000000;
    int constant PRICE_MIN = 1000000;
    int constant EXECUTOR_REWARD = 500000;
    int constant MAX_SHARDS = 256;
    int constant MAX_RECORDS_PER_SHARD = 256;
    int constant MAX_BATCH = {{MAX_BATCH}};
    int constant MIN_DRAW_TICKETS = 3;
    int constant DRAW_DELAY_DAA = 100;
    int constant REROLL_TIMEOUT_DAA = 432000;
    int constant FEE_CAP = 50000000;

    int constant MAX_STATE_BYTES = 17468;
    int constant VALUE_LIMIT = 9000000000000000;
    int constant DAA_LIMIT = 500000000000;
    int constant TOKEN_AMOUNT_LIMIT = 1000000000000000000;

    function pushState(byte[] b): byte[] {
        int n = length(b);
        require(n > 0 && n <= MAX_STATE_BYTES);
        byte[] prefix = byte[](0x4d) + byte[](n as byte[2]);
        if (n <= 75) { prefix = byte[](n as byte[1]); }
        else if (n <= 255) { prefix = byte[](0x4c) + byte[](n as byte[4]).slice(0, 1); }
        return prefix + b;
    }

    function scriptFor(byte[] b, byte[] tail): byte[] {
        require(length(tail) > 0 && tail.slice(0, 1) == byte[](0x6c));
        return byte[](0x6b) + pushState(b) + tail;
    }

    function selfTail(int idx, int n): byte[] {
        int len = OpTxInputScriptSigLen(idx);
        require(n > 0 && n < len && n <= 250000);
        byte[] tail = OpTxInputScriptSigSubstr(idx, len - n, len);
        require(tx.inputs[idx].scriptPubKey == byte[](new ScriptPubKeyP2SHFromRedeemScript(scriptFor(state, tail))));
        return tail;
    }

    function checkKcc20Suffix(byte[] suffix) {
        require(length(suffix) == KCC20_SUFFIX_LEN);
        require(templateHash(KCC20_PREFIX, suffix) == KCC20_EXT_TEMPLATE_HASH);
    }

    function kcc20Spk(int amount, byte[32] owner, byte[] ownerScheme, byte[] suffix): byte[] {
        require(amount > 0 && amount <= TOKEN_AMOUNT_LIMIT && length(ownerScheme) == 1);
        byte[] encoded = byte[](0x08) + byte[](amount as byte[8])
            + byte[](0x20) + byte[](owner)
            + byte[](0x01) + ownerScheme
            + byte[](0x0100)
            + byte[](0x20) + byte[](ZERO)
            + byte[](0x20) + byte[](ZERO);
        return byte[](new ScriptPubKeyP2SHFromRedeemScript(KCC20_PREFIX + encoded + suffix));
    }

    function checkKcc20Input(int idx, int amount, byte[32] owner, byte[] ownerScheme, byte[] suffix, int expectedValue) {
        require(OpInputCovenantId(idx) == KUSDT_CID);
        require(tx.inputs[idx].value == expectedValue);
        require(tx.inputs[idx].scriptPubKey == kcc20Spk(amount, owner, ownerScheme, suffix));
    }

    function checkKcc20Output(int idx, int amount, byte[32] owner, byte[] ownerScheme, byte[] suffix, int minValue, bool exactValue) {
        require(OpOutputCovenantId(idx) == KUSDT_CID);
        if (exactValue) { require(tx.outputs[idx].value == minValue); }
        else { require(tx.outputs[idx].value >= minValue && tx.outputs[idx].value <= VALUE_LIMIT); }
        require(tx.outputs[idx].scriptPubKey == kcc20Spk(amount, owner, ownerScheme, suffix));
    }

    function ordinaryP2PK(int i, int value, pubkey key) {
        require(value > 0 && value <= VALUE_LIMIT && tx.outputs[i].value == value);
        require(tx.outputs[i].scriptPubKey == byte[](new ScriptPubKeyP2PK(key)) && OpOutputCovenantId(i) == ZERO);
    }

    function checkFee(int cap) {
        require(tx.outputs.length >= 1);
        int vi = 0;
        int vo = 0;
        for (fi, 0, tx.inputs.length, FEE_INPUTS) { vi = vi + tx.inputs[fi].value; }
        for (fo, 0, tx.outputs.length, FEE_OUTPUTS) { vo = vo + tx.outputs[fo].value; }
        require(vi > vo && vi - vo <= cap);
    }
