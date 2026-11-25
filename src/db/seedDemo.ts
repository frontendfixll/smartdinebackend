import { RoleModel } from "@modules/roles/role.model";
import { UserModel } from "@modules/users/user.model";
import { BUILT_IN_ROLES } from "@modules/roles/builtInRoles";
import { hashPassword } from "@modules/auth/token.service";
import { connectDatabase, disconnectDatabase } from "./connect";
import { logger } from "@utils/logger";

const DEMO_ACCOUNTS = [
  { roleKey: "owner",      email: "owner@pinky.local",      password: "PinkyLocal-1Yu536rFGEZq", name: "Demo Owner"      },
  { roleKey: "manager",    email: "manager@pinky.local",    password: "PinkyStaff@2026",         name: "Demo Manager"    },
  { roleKey: "cashier",    email: "cashier@pinky.local",    password: "PinkyStaff@2026",         name: "Demo Cashier"    },
  { roleKey: "accountant", email: "accountant@pinky.local", password: "PinkyStaff@2026",         name: "Demo Accountant" },
  { roleKey: "inventory",  email: "inventory@pinky.local",  password: "PinkyStaff@2026",         name: "Demo Inventory"  },
  { roleKey: "host",       email: "host@pinky.local",       password: "PinkyStaff@2026",         name: "Demo Host"       },
  { roleKey: "readonly",   email: "readonly@pinky.local",   password: "PinkyStaff@2026",         name: "Demo Read Only"  },
  { roleKey: "waiter",     email: "waiter@pinky.local",     password: "PinkyStaff@2026",         name: "Demo Waiter"     },
  { roleKey: "kitchen",    email: "kitchen@pinky.local",    password: "PinkyStaff@2026",         name: "Demo Chef"       },
  { roleKey: "expo",       email: "expo@pinky.local",       password: "PinkyStaff@2026",         name: "Demo Expo"       },
  { roleKey: "driver",     email: "driver@pinky.local",     password: "PinkyStaff@2026",         name: "Demo Driver"     },
];

async function seedRoles() {
  for (const def of BUILT_IN_ROLES) {
    const existing = await RoleModel.findOne({ key: def.key });
    if (existing) {
      existing.permissions = def.permissions;
      await existing.save();
    } else {
      await RoleModel.create(def);
    }
  }
  logger.info("Roles upserted");
}

async function seedDemoUsers() {
  for (const account of DEMO_ACCOUNTS) {
    const existing = await UserModel.findOne({ email: account.email });
    if (existing) {
      logger.info(`Already exists: ${account.email}`);
      continue;
    }
    const role = await RoleModel.findOne({ key: account.roleKey });
    if (!role) { logger.warn(`Role not found: ${account.roleKey}`); continue; }
    const passwordHash = await hashPassword(account.password);
    await UserModel.create({
      email: account.email,
      passwordHash,
      name: account.name,
      roleId: role._id,
      isActive: true,
    });
    logger.info(`Created ${account.roleKey}: ${account.email}`);
  }
}

if (require.main === module) {
  connectDatabase()
    .then(seedRoles)
    .then(seedDemoUsers)
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(disconnectDatabase);
}
