import { PayloadTooLargeException } from '@nestjs/common';
import { text } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { MAX_SPEC_BYTES } from './services/api-import.service';

/**
 * Body parsing for `POST /apis/import` only.
 *
 * Two reasons this route cannot use the app's normal JSON parsing:
 *
 *  1. **Size.** Nest's default `json()` limit is 100 kB, so a real-world OAS document would be
 *     rejected long before the 5 MB the acceptance criterion requires.
 *  2. **Format.** The payload is JSON *or* YAML. It is taken as raw text and handed to the YAML
 *     parser, which accepts both (YAML 1.2 is a strict superset of JSON), so `type: () => true`
 *     is deliberate — the content type is not allowed to decide whether the body is read.
 *
 * `body-parser` rejects an oversize payload with a plain `Error` carrying `type:
 * 'entity.too.large'`, NOT an `HttpException`. Left alone that reaches `AllExceptionsFilter` as an
 * unknown error and becomes a **500**, which is why it is translated here: the criterion is a
 * **413**, and the caller gets it in the normal `{success:false,error}` shape.
 */
const parseText = text({ limit: MAX_SPEC_BYTES, type: () => true });

interface BodyParserError extends Error {
  type?: string;
}

export function specBodyMiddleware(req: Request, res: Response, next: NextFunction): void {
  parseText(req, res, (err?: unknown) => {
    if (err && (err as BodyParserError).type === 'entity.too.large') {
      next(
        new PayloadTooLargeException(
          `OAS document exceeds the ${String(MAX_SPEC_BYTES / (1024 * 1024))} MB limit`,
        ),
      );
      return;
    }
    next(err);
  });
}
