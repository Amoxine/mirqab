import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { DeveloperAuthGuard } from '../guards/developer-auth.guard';
import { CurrentDeveloper } from '../decorators/current-developer.decorator';
import type { DeveloperPayload } from '../../../common/types';
import { ApplicationService, type ApplicationDetail } from '../services/application.service';
import { CreateApplicationDto } from '../dto/create-application.dto';

@ApiTags('Portal')
@ApiBearerAuth()
@Public()
@UseGuards(DeveloperAuthGuard)
@Controller('portal/applications')
export class PortalApplicationsController {
  constructor(private readonly applications: ApplicationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register an application (capped per developer)' })
  @ApiResponse({ status: 409, description: 'Application cap reached, or the name is already taken' })
  async create(
    @Body() dto: CreateApplicationDto,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<ApplicationDetail> {
    return this.applications.create(dto, developer.sub);
  }

  @Get()
  @ApiOperation({ summary: 'This developer\'s own applications' })
  async findAll(@CurrentDeveloper() developer: DeveloperPayload): Promise<ApplicationDetail[]> {
    return this.applications.findAll(developer.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One application — 403 if it belongs to a different account' })
  @ApiResponse({ status: 403, description: 'Application belongs to a different developer' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<ApplicationDetail> {
    return this.applications.findOne(id, developer.sub);
  }
}
