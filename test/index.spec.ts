import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function expectDailyBoardHtml(response: Response, body: string) {
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type") ?? "").toContain("text/html");
	expect(body).toContain("<title>K-Prop Demon Hunters</title>");
	expect(body).toContain("<h1>Daily Board</h1>");
	expect(body).toContain('id="board-body"');
	expect(body).toContain('<script src="/app.js" defer></script>');
}

describe("K-Prop Daily Board worker", () => {
	it("serves the Daily Board HTML (unit style)", async () => {
		const request = new IncomingRequest("http://example.com/");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const body = await response.text();
		await waitOnExecutionContext(ctx);

		expectDailyBoardHtml(response, body);
	});

	it("serves the Daily Board HTML (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/");
		const body = await response.text();

		expectDailyBoardHtml(response, body);
	});
});
