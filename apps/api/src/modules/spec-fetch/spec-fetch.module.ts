import { Module } from '@nestjs/common';
import { SPEC_FETCHER } from './spec-fetch.types';
import { SpecFetcherService } from './spec-fetcher.service';

/** OAS-08a: the guarded spec fetcher. Import this module; never `fetch` a tenant spec URL directly. */
@Module({
  providers: [SpecFetcherService, { provide: SPEC_FETCHER, useExisting: SpecFetcherService }],
  exports: [SpecFetcherService, SPEC_FETCHER],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class SpecFetchModule {}
