export function ozonPreparationGatewayBoundaryLockKey(preparationJobId: string): string {
  return `merchroute-ozon-preparation-gateway:${String(preparationJobId || '').trim()}`;
}
