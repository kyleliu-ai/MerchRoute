import type { PricingProductQueryInput, PricingProductQueryResult } from '@n8n-media-review/shared';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import type { PricingRepository } from '../../repositories/pricing.js';

export class ProductPricingQueryService {
  constructor(
    private readonly purchases: PurchaseRepository,
    private readonly pricing: PricingRepository
  ) {}

  async query(input: PricingProductQueryInput): Promise<PricingProductQueryResult> {
    const products = await this.purchases.findPricingProducts(input.lookup);
    return this.pricing.calculateProductQuery(input, products);
  }
}
