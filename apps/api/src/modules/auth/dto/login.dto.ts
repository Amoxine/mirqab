/**
 * DEPRECATED — dead since the Ory cutover (WP2). There is no `POST /auth/login` any more: Kratos
 * owns the login flow and Hydra issues the token (see services/auth.service.ts and
 * strategies/jwt.strategy.ts). Nothing imports this. Kept for history, not deleted (WP7 decision,
 * 2026-09-20); safe to delete in a future pass.
 */
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  password!: string;
}
