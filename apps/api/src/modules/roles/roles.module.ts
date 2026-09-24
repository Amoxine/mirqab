import { Module } from '@nestjs/common';
import { RoleController } from './controllers/role.controller';
import { RoleService } from './services/role.service';

@Module({
  controllers: [RoleController],
  providers: [RoleService],
  exports: [RoleService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class RolesModule {}
