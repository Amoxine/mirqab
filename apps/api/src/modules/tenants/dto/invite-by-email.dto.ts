import { IsEmail, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ASSIGNABLE_ROLES } from './assign-user.dto';

/**
 * Body of `POST /tenants/:id/users/invite` — invite someone who has no account yet (V1-USR-01).
 * `AssignUserDto` can't carry this: its `userId` is `@IsUUID()`, and a person who has never signed up
 * has no id to send. The role list is the same one, for the same super_admin reason.
 *
 * The service lowercases `email` before storing it: Kratos canonicalizes verified addresses to
 * lowercase, and that is what the login route compares against when the invitee claims the row.
 */
export class InviteByEmailDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role!: (typeof ASSIGNABLE_ROLES)[number];
}
