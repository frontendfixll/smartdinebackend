import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

const audience = 'table-visit';
const period = 15 * 60 * 1000;
function codeAt(visit: string, bucket: number) {
  return createHmac('sha256', config.jwt.guestSecret)
    .update('table-join|' + visit + '|' + bucket)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}
export function joinCode(visit: string, now = Date.now()) {
  return codeAt(visit, Math.floor(now / period));
}
export function codeMatches(visit: string, code: string, now = Date.now()) {
  if (!/^[A-F0-9]{8}$/.test(code)) return false;
  return [now, now - period].some((time) =>
    timingSafeEqual(Buffer.from(joinCode(visit, time)), Buffer.from(code)),
  );
}
export function grantVisit(visit: string) {
  return jwt.sign({}, config.jwt.guestSecret, {
    subject: visit,
    audience,
    jwtid: randomUUID(),
    expiresIn: '4h',
    algorithm: 'HS256',
  });
}
export function grantedVisit(token: unknown) {
  try {
    if (typeof token !== 'string') throw new Error();
    const claims = jwt.verify(token, config.jwt.guestSecret, { audience, algorithms: ['HS256'] });
    if (typeof claims === 'string' || !claims.sub || !/^[a-f0-9]{24}$/.test(claims.sub))
      throw new Error();
    return claims.sub;
  } catch {
    throw AppError.forbidden('Join the current visit with the code from your waiter');
  }
}
