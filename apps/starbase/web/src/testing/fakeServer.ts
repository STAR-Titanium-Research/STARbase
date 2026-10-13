import { AxiosError, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

export type Reply = number | 'network' | { status: number; data: unknown };

// A fake d1-server for unit tests: every request made through `api` is answered by `route`, keyed
// "METHOD /path" (the path as the caller wrote it, without the query), with no network. A 4xx/5xx
// rejects exactly as axios does (an AxiosError carrying `response`), 'network' rejects with no response.
// Returns the requests made, in order.
export function fakeServer(api: AxiosInstance, route: (key: string, cfg: InternalAxiosRequestConfig) => Reply): string[] {
	const calls: string[] = [];
	api.defaults.adapter = async (cfg: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
		const key = `${(cfg.method ?? 'get').toUpperCase()} ${cfg.url}`;
		calls.push(key);
		const reply = route(key, cfg);
		if (reply === 'network') throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, cfg);
		const { status, data } = typeof reply === 'number' ? { status: reply, data: { data: {} } } : reply;
		const response = { data, status, statusText: String(status), headers: {}, config: cfg } as AxiosResponse;
		if (status >= 400) throw new AxiosError(`HTTP ${status}`, AxiosError.ERR_BAD_RESPONSE, cfg, null, response);
		return response;
	};
	return calls;
}
