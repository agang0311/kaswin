export interface RefundReserveInput { maxBatches: number; maxBatchesPerTransaction?: number; transitionFeeSompi: bigint; refundFeePerTransactionSompi: bigint; finalizationFeeSompi: bigint; safetyMarginSompi?: bigint }
export function estimateWorstCaseRefundReserve(input: RefundReserveInput): bigint {
  const perTx = input.maxBatchesPerTransaction ?? 13;
  if (!Number.isSafeInteger(input.maxBatches) || input.maxBatches < 1 || !Number.isSafeInteger(perTx) || perTx < 1 || perTx > 13) throw new Error("Invalid refund batch capacity.");
  const values = [input.transitionFeeSompi, input.refundFeePerTransactionSompi, input.finalizationFeeSompi, input.safetyMarginSompi ?? 0n];
  if (values.some((value) => value < 0n)) throw new Error("Fees cannot be negative.");
  const transactions = BigInt(Math.ceil(input.maxBatches / perTx));
  return input.transitionFeeSompi + transactions * input.refundFeePerTransactionSompi + input.finalizationFeeSompi + (input.safetyMarginSompi ?? 0n);
}
export function buyerRefundPrincipal(ticketPriceSompi: bigint, ticketCount: number): bigint {
  if (ticketPriceSompi <= 0n || !Number.isSafeInteger(ticketCount) || ticketCount <= 0) throw new Error("Invalid refund principal inputs.");
  return ticketPriceSompi * BigInt(ticketCount);
}
export function successorRefundValue(currentValue: bigint, principals: readonly bigint[], actualFee: bigint, remainingPrincipal: bigint): bigint {
  if (actualFee <= 0n || remainingPrincipal < 0n || principals.some((value) => value <= 0n)) throw new Error("Invalid refund values.");
  const successor = currentValue - principals.reduce((sum, value) => sum + value, 0n) - actualFee;
  if (successor < remainingPrincipal) throw new Error("Carrier is insufficient; buyer principal cannot be reduced.");
  return successor;
}

/** vNext refund fees come from the selected ticket payments, not the carrier. */
export function vNextMandatoryRefundReserve(remainingBatches: number, refundFeeCapSompi: bigint): bigint {
  if (!Number.isSafeInteger(remainingBatches) || remainingBatches < 0 || refundFeeCapSompi <= 0n) throw new Error("Invalid vNext refund reserve inputs.");
  return 0n;
}

export function vNextRefundOwnerValues(principals: readonly bigint[], actualFee: bigint, transitionFeeDebt: bigint, minimumOwnerOutput = 1n): bigint[] {
  if (!principals.length || actualFee <= 0n || transitionFeeDebt < 0n || minimumOwnerOutput <= 0n || principals.some((value) => value <= 0n)) throw new Error("Invalid buyer-funded refund values.");
  const totalFee = actualFee + transitionFeeDebt;
  const perBatch = totalFee / BigInt(principals.length);
  const remainder = totalFee % BigInt(principals.length);
  return principals.map((principal, index) => {
    const value = principal - perBatch - (index === 0 ? remainder : 0n);
    if (value < minimumOwnerOutput) throw new Error("A purchase batch cannot preserve the minimum owner output after refund fees.");
    return value;
  });
}

export function vNextSuccessorRefundValue(currentValue: bigint, principals: readonly bigint[], transitionFeeDebt: bigint, remainingPrincipal: bigint): bigint {
  if (transitionFeeDebt < 0n || remainingPrincipal < 0n || principals.some((value) => value <= 0n)) throw new Error("Invalid buyer-funded refund successor values.");
  const successor = currentValue - principals.reduce((sum, value) => sum + value, 0n) + transitionFeeDebt;
  if (successor < remainingPrincipal) throw new Error("Refund transaction would reduce remaining ticket principal.");
  return successor;
}
