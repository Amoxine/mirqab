import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Query of `GET /tenants/:id/users/lookup` — the email an admin is trying to invite. */
export class LookupUserDto {
  @ApiProperty()
  @IsEmail()
  email!: string;
}
