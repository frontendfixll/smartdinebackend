import { Request, Response, NextFunction } from 'express';
import { verifyOrderAccess } from '@modules/auth/orderAccess.service';
export function requireOrderAccess(req: Request, _res: Response, next: NextFunction) {
  try {
    verifyOrderAccess(req.headers['x-order-token'], req.params.id);
    next();
  } catch (error) {
    next(error);
  }
}
