import jwt from 'jsonwebtoken';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

export function signReservationAccess(id: string): string {
  return jwt.sign({ sub: id, type: 'reservation_access' }, config.jwt.guestSecret, {
    algorithm: 'HS256',
    audience: 'guest-reservation',
    expiresIn: '180d',
  });
}
export function verifyReservationAccess(token: unknown, id: string): void {
  try {
    if (typeof token !== 'string') throw new Error('Missing token');
    const payload = jwt.verify(token, config.jwt.guestSecret, {
      algorithms: ['HS256'],
      audience: 'guest-reservation',
    }) as jwt.JwtPayload;
    if (payload.type !== 'reservation_access' || payload.sub !== id)
      throw new Error('Wrong reservation');
  } catch {
    throw AppError.unauthorized(
      'Use your private booking link or contact the restaurant to manage this reservation.',
    );
  }
}
