import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * One MCP primitive exposed by an `McpServer` — a tool, derived from a single operation of the
 * paired source API's OpenAPI document.
 *
 * Tyk 5.15.0 OSS names a primitive's source by `operationId` (or by path+method); this product uses
 * `operationId` only, because that is the one identifier the source document already guarantees to
 * be unique and that survives a path change.
 *
 * Only tools are modelled. The gateway's extension schema has `mcpResources` and `mcpPrompts` blocks
 * of the same shape, but a REST-as-MCP adapter derives every primitive from a REST operation, which
 * is a tool — there is nothing for the other two to point at. Adding them later needs a `type`
 * discriminator here and one more branch in the mapper, nothing structural.
 */
export class McpToolDto {
  @ApiProperty({
    description: "The source API operation this tool calls, by its OpenAPI `operationId`.",
    example: 'getOrderStatus',
  })
  @IsString()
  @MaxLength(128)
  operationId!: string;

  @ApiProperty({
    description:
      'The tool name MCP clients see. Tyk enforces this character set on the gateway side; rejecting ' +
      'it here turns a definition the gateway would refuse into a 400 the caller can act on.',
    example: 'get_order_status',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,128}$/, {
    message: 'name may contain only letters, digits, underscore, dot and hyphen (1-128 characters)',
  })
  name!: string;

  @ApiPropertyOptional({ description: 'Shown to the MCP client in `tools/list`.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  /**
   * Per-primitive rate limit. Delivered to the gateway as the plan policy's
   * `access_rights[<mcpApiId>].mcp_primitives[]` entry, NOT as the API definition's
   * `middleware.mcpTools.<name>.rateLimit`: that second block round-trips into storage on 5.15.0
   * and is then never enforced (live-verified — 13/13 calls served with `rate: 10`), so building on
   * it would ship a limit that silently does nothing. See `mcp-mapper.ts`.
   */
  @ApiPropertyOptional({
    description:
      'Calls allowed per `ratePer` seconds, for THIS tool alone. Requires the calling key to be on ' +
      'a plan — the limit rides that plan’s policy. Omit for no per-tool limit.',
    minimum: 1,
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  rateLimit?: number;

  // `@ValidateIf` rather than `@IsOptional`, and deliberately without it: when `rateLimit` is set
  // this field becomes REQUIRED, because a rate with no window is not a limit — and Tyk reads
  // `per: 0` as "no rate limiting at all" rather than rejecting it, so the mistake would be silent.
  // With `rateLimit` absent the predicate is false and nothing here runs, which is the optional case.
  @ApiPropertyOptional({ description: 'Window in seconds for `rateLimit`.', minimum: 1, example: 60 })
  @ValidateIf((o: McpToolDto) => o.rateLimit !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(86_400)
  ratePer?: number;

  /**
   * TBAC. When set, only a key whose plan is this one may call the tool; any other key gets 403
   * ("tool '<name>' is not available") and does not even see the tool in `tools/list` — the gateway
   * filters the listing per key. Null/absent means every key scoped to this server may call it.
   */
  @ApiPropertyOptional({
    description:
      'Bind this tool to a plan. Only keys on that plan may call it — others get 403 and the tool is ' +
      'hidden from their `tools/list`. Omit to leave the tool open to every key on this server.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  planId?: string;
}
