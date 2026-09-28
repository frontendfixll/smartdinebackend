import { UserModel } from '@modules/users/user.model';
import { RoleModel } from './role.model';
import { AppError } from '@utils/AppError';
export async function assertCanDelegate(
  actorId: string | undefined,
  permissions: readonly string[],
  targetKey?: string,
) {
  if (!actorId) throw AppError.unauthorized();
  const actor = await UserModel.findOne({ _id: actorId, isActive: true }).lean();
  if (!actor) throw AppError.unauthorized();
  const role = await RoleModel.findById(actor.roleId).lean();
  if (!role) throw AppError.unauthorized();
  if (targetKey === 'owner' && role.key !== 'owner')
    throw AppError.forbidden('Only the owner can manage the owner account');
  if (!role.permissions.includes('*') && permissions.some((p) => !role.permissions.includes(p)))
    throw AppError.forbidden('You cannot manage a role with permissions beyond your own');
  return role;
}
