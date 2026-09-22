/**
 * DEPRECATED — dead since the Ory cutover (WP2). There is no `POST /auth/register` any more: Kratos
 * owns self-service registration, including the password policy this file used to encode (see
 * infra/ory/kratos/). Nothing imports this. Kept for history, not deleted (WP7 decision,
 * 2026-09-20); safe to delete in a future pass.
 */
import { IsEmail, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @MinLength(2)
  @Matches(/^[a-zA-Z\s-]+$/, { message: 'Name can only contain letters, spaces, and hyphens' })
  name!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
  })
  password!: string;
}
