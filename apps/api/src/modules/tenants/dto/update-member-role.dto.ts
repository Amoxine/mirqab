import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ASSIGNABLE_ROLES } from './assign-user.dto';

/** Body of `PATCH /tenants/:id/users/:userId`. */
export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role!: (typeof ASSIGNABLE_ROLES)[number];
}
