import { verifyAccessToken } from '@modules/auth/token.service';
import { verifyOrderAccess } from '@modules/auth/orderAccess.service';
import { UserModel } from '@modules/users/user.model';
import { RoleModel } from '@modules/roles/role.model';
import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { config } from '@config/index';
import { logger } from '@utils/logger';

let io: SocketServer | null = null;

export function initSockets(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin:
        config.corsOrigin === '*'
          ? true
          : config.corsOrigin.split(',').map((value) => value.trim()),
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  for (const name of ['/staff', '/kds']) {
    io.of(name).use(async (socket, next) => {
      try {
        const payload = verifyAccessToken(socket.handshake.auth.token);
        const user = await UserModel.findById(payload.sub).lean();
        if (!user?.isActive) throw new Error('Account inactive');
        const role = await RoleModel.findById(user.roleId).lean();
        const required = name === '/kds' ? 'kds:read' : 'order:read';
        if (!role || (!role.permissions.includes('*') && !role.permissions.includes(required)))
          throw new Error('Forbidden');
        // Do not retain an authenticated connection beyond its access-token expiry.
        const expiresAt = (payload as typeof payload & { exp: number }).exp * 1000;
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
          throw new Error('Token expired');
        const timer = setTimeout(() => socket.disconnect(true), expiresAt - Date.now());
        socket.once('disconnect', () => clearTimeout(timer));
        next();
      } catch (cause) {
        const error = new Error('Staff authentication required') as Error & {
          data?: { code: string };
        };
        error.data = {
          code: (cause as Error).name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'FORBIDDEN',
        };
        next(error);
      }
    });
  }
  io.of('/guest').use((socket, next) => {
    try {
      if (typeof socket.handshake.query.orderId !== 'string') throw new Error('Order required');
      verifyOrderAccess(socket.handshake.auth.orderToken, socket.handshake.query.orderId);
      next();
    } catch {
      next(new Error('Private order access required'));
    }
  });

  io.of('/kds').on('connection', (socket: Socket) => {
    logger.info({ id: socket.id }, 'KDS socket connected');
    socket.on('station:join', (station: string) => {
      if (typeof station === 'string' && /^[a-zA-Z0-9 _-]{1,80}$/.test(station))
        socket.join(`station:${station}`);
    });
    socket.on('disconnect', () => logger.info({ id: socket.id }, 'KDS socket disconnected'));
  });

  io.of('/staff').on('connection', (socket: Socket) => {
    logger.info({ id: socket.id }, 'Staff socket connected');
    socket.on('disconnect', () => logger.info({ id: socket.id }, 'Staff socket disconnected'));
  });

  io.of('/guest').on('connection', (socket: Socket) => {
    const { orderId } = socket.handshake.query;
    if (typeof orderId === 'string') socket.join(`order:${orderId}`);
  });

  io.of('/now-serving').on('connection', (socket: Socket) => {
    logger.info({ id: socket.id }, 'Now-serving board connected');
  });

  io.of('/menu').on('connection', (socket: Socket) => {
    logger.debug({ id: socket.id }, 'Menu listener connected');
  });

  return io;
}

export function getIo(): SocketServer {
  if (!io) throw new Error('Socket.IO not initialized — call initSockets first');
  return io;
}
