import jwt from 'jsonwebtoken';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

export interface OrderAccess {
  sub: string;
  orderNumber: string;
  type: 'order_access';
}
export function signOrderAccess(orderId: string, orderNumber: string): string {
  return jwt.sign({ sub: orderId, orderNumber, type: 'order_access' }, config.jwt.guestSecret, {
    algorithm: 'HS256',
    expiresIn: '7d',
    audience: 'guest-order',
  });
}
export function verifyOrderAccess(token: unknown, orderId?: string): OrderAccess {
  try {
    if (typeof token !== 'string') throw new Error('Missing token');
    const payload = jwt.verify(token, config.jwt.guestSecret, {
      algorithms: ['HS256'],
      audience: 'guest-order',
    }) as OrderAccess;
    if (
      payload.type !== 'order_access' ||
      typeof payload.sub !== 'string' ||
      typeof payload.orderNumber !== 'string'
    )
      throw new Error('Invalid token');
    if (orderId && payload.sub !== orderId) throw new Error('Wrong order');
    return payload;
  } catch {
    throw AppError.unauthorized(
      'This order requires its private access token. Open it on the device used to order or ask staff for help.',
    );
  }
}
