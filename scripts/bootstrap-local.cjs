if (!process.env.RESTAURANT_ENV_FILE || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(process.env.MONGODB_URI || '')) {
  console.error('Run npm run dev:local -- --bootstrap with a local configuration.');process.exit(1);
}
const password=process.env.LOCAL_OWNER_PASSWORD;
if (!password || password.length < 16 || password.startsWith('replace-')) {
  console.error('Set a unique LOCAL_OWNER_PASSWORD of at least 16 characters in backend/.env.local.');process.exit(1);
}
const mongoose=require('mongoose');
const {RoleModel}=require('../dist/modules/roles/role.model');
const {UserModel}=require('../dist/modules/users/user.model');
const {RestaurantModel}=require('../dist/modules/restaurant/restaurant.model');
const {OrderRequestModel}=require('../dist/modules/orders/orderRequest.service');
const {BUILT_IN_ROLES}=require('../dist/modules/roles/builtInRoles');
const {hashPassword}=require('../dist/modules/auth/token.service');
(async()=>{
 await mongoose.connect(process.env.MONGODB_URI);
 const hello=await mongoose.connection.db.admin().command({hello:1});
 if(!hello.setName)throw new Error('Local MongoDB must be a replica set.');
 await OrderRequestModel.init();
 for(const role of BUILT_IN_ROLES)await RoleModel.updateOne({key:role.key},{$setOnInsert:role},{upsert:true});
 const role=await RoleModel.findOne({key:'owner'});
 const email=process.env.LOCAL_OWNER_EMAIL || 'owner@pinky.local';
 if(!await UserModel.exists({email}))await UserModel.create({email,name:process.env.LOCAL_OWNER_NAME || 'Pinky Promise Owner',passwordHash:await hashPassword(password),roleId:role._id,isActive:true});
 if(!await RestaurantModel.exists({singleton:'main'}))await RestaurantModel.create({singleton:'main'});
 console.log('Local owner and empty Pinky Promise restaurant are ready. Configure menu, hours and taxes through the admin panel.');
 await mongoose.disconnect();
})().catch(async error=>{console.error(error.message);await mongoose.disconnect();process.exitCode=1});
