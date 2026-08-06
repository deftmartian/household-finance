export function permitsProductionContractRotation({
  explicitlyAllowed,
  existingContract,
  nonce,
  budget,
  liveProductionSentinels,
}) {
  const existingSentinels =
    existingContract === undefined
      ? []
      : liveProductionSentinels.filter(
          (payee) => payee.name === existingContract.sentinelPayee.name,
        );
  return (
    explicitlyAllowed &&
    existingContract !== undefined &&
    existingContract.nonce === nonce &&
    existingContract.budget.syncId === budget.syncId &&
    existingContract.budget.name === budget.name &&
    existingSentinels.length === 1 &&
    existingSentinels[0].id === existingContract.sentinelPayee.id
  );
}
