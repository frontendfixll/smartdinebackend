jest.mock('../src/config', () => ({ config: { jwt: { guestSecret: 'test-only-guest-secret-at-least-32-chars' } } }));
import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import { signOrderAccess, verifyOrderAccess } from '../src/modules/auth/orderAccess.service';
import { requireOrderAccess } from '../src/middleware/requireOrderAccess';

const orderA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orderB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
test('capabilities are bound to one order and reject missing or tampered tokens', () => {
  const token = signOrderAccess(orderA, '20260921-0001');
  expect(verifyOrderAccess(token, orderA).sub).toBe(orderA);
  expect(() => verifyOrderAccess(token, orderB)).toThrow();
  expect(() => verifyOrderAccess(undefined, orderA)).toThrow();
  expect(() => verifyOrderAccess(token + 'x', orderA)).toThrow();
});
test('rejects expired tokens and verified-phone tokens', () => {
  const secret = 'test-only-guest-secret-at-least-32-chars';
  const expired = jwt.sign({ sub: orderA, orderNumber: '1', type: 'order_access' }, secret, { audience: 'guest-order', expiresIn: -1 });
  const phone = jwt.sign({ phone: '+13105550123', type: 'guest_verified' }, secret);
  expect(() => verifyOrderAccess(expired)).toThrow();
  expect(() => verifyOrderAccess(phone)).toThrow();
});
test('HTTP middleware blocks a known ID without matching capability', async () => {
  const app = express();
  app.use('/:id', requireOrderAccess);
  app.post('/:id/items', (_req, res) => { res.json({ success: true }); });
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).end(); });
  const token = signOrderAccess(orderA, '1');
  expect((await request(app).post(`/${orderA}/items`)).status).toBe(401);
  expect((await request(app).post(`/${orderB}/items`).set('X-Order-Token', token)).status).toBe(401);
  expect((await request(app).post(`/${orderA}/items`).set('X-Order-Token', token)).status).toBe(200);
});
