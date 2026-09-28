jest.mock('../src/config', () => ({ config: { corsOrigin: '*', jwt: { accessSecret: 'test-access-secret-32-characters-long', accessExpiresIn: '15m', guestSecret: 'test-guest-secret-32-characters-long' } } }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), debug: jest.fn() } }));
import { createServer } from 'http';
import { io as connect, Socket } from '../../frontend/node_modules/socket.io-client';
import { initSockets } from '../src/sockets';
import { signAccessToken } from '../src/modules/auth/token.service';
import { signOrderAccess } from '../src/modules/auth/orderAccess.service';
import { UserModel } from '../src/modules/users/user.model';
import { RoleModel } from '../src/modules/roles/role.model';

const server = createServer();
const io = initSockets(server);
const clients: Socket[] = [];
let base: string;
beforeAll(async () => { await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${(server.address() as {port:number}).port}`; });
afterAll(async () => { clients.forEach(c=>c.disconnect()); await new Promise<void>(resolve=>io.close(()=>resolve())); });
function attempt(namespace: string, auth: Record<string,string> = {}, query: Record<string,string> = {}) {
 return new Promise<string>((resolve,reject)=>{
  const c=connect(base+namespace,{auth,query,transports:['websocket'],reconnection:false,timeout:1500}); clients.push(c);
  const timer=setTimeout(()=>{c.disconnect();reject(new Error('Connection did not resolve'));},3000);
  c.once('connect',()=>{clearTimeout(timer);resolve('connected')});
  c.once('connect_error',error=>{clearTimeout(timer);resolve(error.message)});
 });
}
test('anonymous staff and kitchen connections are rejected', async()=>{
 expect(await attempt('/staff')).toBe('Staff authentication required');
 expect(await attempt('/kds')).toBe('Staff authentication required');
});
test('guest must own the requested order room',async()=>{
 const token=signOrderAccess('aaaaaaaaaaaaaaaaaaaaaaaa','1');
 expect(await attempt('/guest',{}, {orderId:'aaaaaaaaaaaaaaaaaaaaaaaa'})).toBe('Private order access required');
 expect(await attempt('/guest',{orderToken:token},{orderId:'bbbbbbbbbbbbbbbbbbbbbbbb'})).toBe('Private order access required');
 expect(await attempt('/guest',{orderToken:token},{orderId:'aaaaaaaaaaaaaaaaaaaaaaaa'})).toBe('connected');
});
test('staff role must grant the namespace permission',async()=>{
 jest.spyOn(UserModel,'findById').mockReturnValue({lean:async()=>({isActive:true,roleId:'role'})} as never);
 const role=jest.spyOn(RoleModel,'findById').mockReturnValue({lean:async()=>({permissions:['billing:read']})} as never);
 const token=signAccessToken({sub:'user',roleKey:'cashier'});
 expect(await attempt('/kds',{token})).toBe('Staff authentication required');
 role.mockReturnValue({lean:async()=>({permissions:['kds:read']})} as never);
 expect(await attempt('/kds',{token})).toBe('connected');
 jest.restoreAllMocks();
});
