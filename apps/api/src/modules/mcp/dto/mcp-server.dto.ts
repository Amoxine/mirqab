import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { McpToolDto } from './mcp-tool.dto';

export class CreateMcpServerDto {
  @ApiProperty({ description: 'Display name, also the MCP server name clients see.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description: 'URL-safe identifier, unique within the tenant.',
    example: 'orders-mcp',
  })
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric segments separated by single hyphens',
  })
  @MaxLength(60)
  slug!: string;

  @ApiProperty({
    description:
      'The paired source API. Must be an OAS-format definition in this tenant that is already synced ' +
      'to the gateway — Tyk builds the MCP server from its OpenAPI document and refuses a Classic one.',
    format: 'uuid',
  })
  @IsUUID()
  sourceApiId!: string;

  @ApiProperty({
    description:
      'Where the proxy listens, before tenant prefixing. The MCP endpoint is `POST {listenPath}/mcp` ' +
      '— streamable HTTP is the only transport Tyk 5.15.0 serves for an MCP proxy.',
    example: '/orders-mcp/',
  })
  @IsString()
  @Matches(/^\/[A-Za-z0-9\-_/.]*$/, { message: 'listenPath must start with / and be URL-safe' })
  @MaxLength(120)
  listenPath!: string;

  @ApiPropertyOptional({
    description: 'Tools to expose, each derived from one operation of the source API.',
    type: [McpToolDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => McpToolDto)
  tools?: McpToolDto[];
}

/**
 * Every field optional, except that `sourceApiId` cannot be changed at all: every tool names an
 * operation of the paired document, so re-pairing would silently redefine what each existing tool
 * calls. Point a new server at the other API instead.
 *
 * `tools` is replaced wholesale when present, never merged: a merge would have no way to express
 * "remove this tool", and a tool that silently survives its own deletion is a grant that outlives
 * the decision to withdraw it.
 */
export class UpdateMcpServerDto extends PartialType(
  OmitType(CreateMcpServerDto, ['sourceApiId'] as const),
) {}
