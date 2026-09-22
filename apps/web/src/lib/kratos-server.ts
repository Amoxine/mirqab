import { Configuration, FrontendApi } from '@ory/client-fetch';

/**
 * Server-to-server Kratos client: the web container reaches Kratos in-network, unlike the browser
 * (`@/lib/kratos-client.ts`, which uses the host-published `NEXT_PUBLIC_KRATOS_URL`). Never import
 * this into a 'use client' component.
 */
const configured = process.env.KRATOS_INTERNAL_URL ?? '';
export const KRATOS_INTERNAL_URL = configured === '' ? 'http://kratos:4433' : configured;

export const kratosServer = new FrontendApi(new Configuration({ basePath: KRATOS_INTERNAL_URL }));
