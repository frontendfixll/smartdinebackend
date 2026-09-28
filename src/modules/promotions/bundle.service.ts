import { BundleModel } from './bundle.model';
import { CustomerTag } from './bundle.model';
import { round2 } from '@utils/math';

export async function getActiveBundles() {
  const now = new Date();
  return BundleModel.find({
    isActive: true,
    validFrom: { $lte: now },
    validTill: { $gte: now },
  }).lean();
}

export async function getBundlesByType(type: 'bogo' | 'combo_discount' | 'volume_discount') {
  const now = new Date();
  return BundleModel.find({
    type,
    isActive: true,
    validFrom: { $lte: now },
    validTill: { $gte: now },
  }).lean();
}

export async function checkBundleEligibility(bundleId: string, customerTags: CustomerTag[], orderValue: number) {
  const bundle = await BundleModel.findById(bundleId);
  if (!bundle) return { eligible: false, reason: 'Bundle not found' };

  const now = new Date();
  if (now < bundle.validFrom || now > bundle.validTill) {
    return { eligible: false, reason: 'Bundle expired' };
  }

  if (bundle.applicableToTags && bundle.applicableToTags.length > 0) {
    const hasTag = bundle.applicableToTags.some(tag => customerTags.includes(tag));
    if (!hasTag) return { eligible: false, reason: 'Not applicable to customer' };
  }

  if (bundle.minOrderValue && orderValue < bundle.minOrderValue) {
    return { eligible: false, reason: `Minimum order value: ₹${bundle.minOrderValue}` };
  }

  return { eligible: true };
}

export async function calculateBundleDiscount(bundleId: string, lineItems: any[], orderValue: number) {
  const bundle = await BundleModel.findById(bundleId);
  if (!bundle) return 0;

  if (bundle.type === 'bogo') {
    const triggerQty = lineItems.filter(i => String(i.itemId) === String(bundle.triggerItemId)).length;
    return triggerQty > 0 ? 1 : 0; // Returns number of free items
  }

  if (bundle.type === 'combo_discount') {
    if (bundle.discountPercent) {
      return round2((orderValue * bundle.discountPercent) / 100);
    }
    return bundle.discountAmount || 0;
  }

  return 0;
}
