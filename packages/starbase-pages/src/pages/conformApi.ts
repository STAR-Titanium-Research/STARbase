// The Conform helpers of @d1/fast-plotting take an axios instance; both hosts' `api` (HostApi) is one, narrowed to the
// calls the pages make. This is the one place that says so (the type is read off the helper, so the pages need no axios of their own).
import type { loadConformRun } from '@d1/fast-plotting';
import type { HostApi } from '@d1/ui';

export type ConformHttp = Parameters<typeof loadConformRun>[0];

export const conformApi = (api: HostApi): ConformHttp => api as unknown as ConformHttp;
