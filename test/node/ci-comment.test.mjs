import assert from "node:assert/strict";
import test from "node:test";

import { CI_COMMENT_MARKER, upsertStickyComment } from "../../dist/report/pr-comment.js";

const repository = "acme/mobile-app";
const issueNumber = 42;
const token = "github-token-do-not-leak";
const authorLogin = "github-actions[bot]";
const body = `${CI_COMMENT_MARKER}\n\n## Explore report\n\n2 screens changed.`;

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function requestRecord(input, init = {}) {
  return {
    url: String(input),
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: init.body,
    redirect: init.redirect,
    signal: init.signal,
  };
}

function assertGitHubHeaders(request) {
  assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
  assert.equal(request.headers.get("accept"), "application/vnd.github+json");
  assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
}

test("paginates comments and updates only the marker comment from the requested author", async () => {
  const apiUrl = "https://github.example/api/v3/";
  const pageOneUrl = `${apiUrl}repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=1`;
  const pageTwoUrl = `${apiUrl}repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=2`;
  const updateUrl = `${apiUrl}repos/${repository}/issues/comments/314`;
  const calls = [];

  const fetchImpl = async (input, init) => {
    const request = requestRecord(input, init);
    calls.push(request);

    if (request.url === pageOneUrl && request.method === "GET") {
      return jsonResponse(
        [
          {
            id: 111,
            body: `${CI_COMMENT_MARKER}\n\nThis belongs to another bot.`,
            user: { login: "another-bot[bot]" },
          },
          {
            id: 112,
            body: "A regular comment without the sticky marker.",
            user: { login: authorLogin },
          },
        ],
        {
          headers: {
            link: `<${pageTwoUrl}>; rel="next", <${pageTwoUrl}>; rel="last"`,
          },
        },
      );
    }

    if (request.url === pageTwoUrl && request.method === "GET") {
      return jsonResponse([
        {
          id: 314,
          body: `${CI_COMMENT_MARKER}\n\nPrevious Explore report.`,
          user: { login: authorLogin },
        },
      ]);
    }

    if (request.url === updateUrl && request.method === "PATCH") {
      return jsonResponse({
        id: 314,
        html_url: "https://github.example/acme/mobile-app/issues/42#issuecomment-314",
      });
    }

    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  const result = await upsertStickyComment({
    repository,
    issueNumber,
    body,
    token,
    authorLogin,
    apiUrl,
    trustedApiOrigin: "https://github.example",
    fetchImpl,
  });

  assert.deepEqual(result, {
    operation: "updated",
    commentId: 314,
    url: "https://github.example/acme/mobile-app/issues/42#issuecomment-314",
    previousBody: "<!-- expo-explore-ci -->\n\nPrevious Explore report.",
  });
  assert.deepEqual(
    calls.map(({ method, url }) => ({ method, url })),
    [
      { method: "GET", url: pageOneUrl },
      { method: "GET", url: pageTwoUrl },
      { method: "PATCH", url: updateUrl },
    ],
  );

  for (const request of calls) {
    assertGitHubHeaders(request);
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[2].headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[2].body), { body });
});

test("creates a new sticky comment when only another author's marker comment exists", async () => {
  const listUrl = `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=1`;
  const createUrl = `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`;
  const calls = [];

  const fetchImpl = async (input, init) => {
    const request = requestRecord(input, init);
    calls.push(request);

    if (request.url === listUrl && request.method === "GET") {
      return jsonResponse([
        {
          id: 271,
          body: `${CI_COMMENT_MARKER}\n\nDo not overwrite this comment.`,
          user: { login: "another-bot[bot]" },
        },
        {
          id: 272,
          body: `A quoted marker is not owned:\n${CI_COMMENT_MARKER}`,
          user: { login: authorLogin },
        },
      ]);
    }

    if (request.url === createUrl && request.method === "POST") {
      return jsonResponse({ id: 315 }, { status: 201 });
    }

    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  const result = await upsertStickyComment({
    repository,
    issueNumber,
    body,
    token,
    authorLogin,
    fetchImpl,
  });

  assert.equal(result.operation, "created");
  assert.equal(result.commentId, 315);
  assert.equal(result.url, undefined);
  assert.deepEqual(
    calls.map(({ method, url }) => ({ method, url })),
    [
      { method: "GET", url: listUrl },
      { method: "POST", url: createUrl },
    ],
  );
  for (const request of calls) {
    assertGitHubHeaders(request);
    assert.equal(request.redirect, "error");
  }
  assert.equal(calls[1].headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[1].body), { body });
});

test("reports non-success responses without exposing the GitHub token", async () => {
  const fetchImpl = async () => jsonResponse(
    { message: `Bad credentials: ${token}` },
    { status: 401, statusText: "Unauthorized" },
  );

  let caught;
  try {
    await upsertStickyComment({
      repository,
      issueNumber,
      body,
      token,
      authorLogin,
      fetchImpl,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.match(caught.message, /GitHub|comment|401|Unauthorized/i);
  assert.doesNotMatch(caught.message, new RegExp(token));
  assert.doesNotMatch(caught.stack ?? "", new RegExp(token));
});

test("retries transient reads but does not blindly retry a comment-creation POST", async () => {
  const listUrl = `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=1`;
  const createUrl = `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`;
  const calls = [];

  const fetchImpl = async (input, init) => {
    const request = requestRecord(input, init);
    calls.push(request);
    if (request.url === listUrl && calls.length === 1) {
      return jsonResponse(
        { message: `temporary failure: ${token}` },
        { status: 503, headers: { "retry-after": "0" } },
      );
    }
    if (request.url === listUrl && calls.length === 2) return jsonResponse([]);
    if (request.url === createUrl) {
      return jsonResponse(
        { message: `ambiguous failure: ${token}` },
        { status: 503, headers: { "retry-after": "0" } },
      );
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  let caught;
  try {
    await upsertStickyComment({
      repository,
      issueNumber,
      body,
      token,
      authorLogin,
      fetchImpl,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "GitHub comment request failed with HTTP 503");
  assert.doesNotMatch(caught.message, new RegExp(token));
  assert.deepEqual(
    calls.map(({ method, url }) => ({ method, url })),
    [
      { method: "GET", url: listUrl },
      { method: "GET", url: listUrl },
      { method: "POST", url: createUrl },
    ],
  );
});

test("bounds stalled requests even when the transport ignores abort", async () => {
  let requestCount = 0;
  let abortCount = 0;
  const fetchImpl = async (_input, init) => {
    requestCount += 1;
    init.signal.addEventListener("abort", () => {
      abortCount += 1;
    }, { once: true });
    return await new Promise(() => {
      // Deliberately ignore abort to prove the caller's own deadline is bounded.
    });
  };

  let caught;
  try {
    await upsertStickyComment({
      repository,
      issueNumber,
      body,
      token,
      authorLogin,
      requestTimeoutMs: 5,
      fetchImpl,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "GitHub comment request timed out after 5ms");
  assert.doesNotMatch(caught.message, new RegExp(token));
  assert.doesNotMatch(caught.stack ?? "", new RegExp(token));
  assert.equal(requestCount, 3);
  assert.equal(abortCount, 3);
});

test("sanitizes repeated network failures", async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    throw new Error(`network failure containing ${token}`);
  };

  let caught;
  try {
    await upsertStickyComment({
      repository,
      issueNumber,
      body,
      token,
      authorLogin,
      fetchImpl,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "GitHub comment request failed after a network error");
  assert.doesNotMatch(caught.message, new RegExp(token));
  assert.doesNotMatch(caught.stack ?? "", new RegExp(token));
  assert.equal(requestCount, 3);
});

test("rejects invalid inputs before making a request", async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    throw new Error("fetch should not be called");
  };
  const valid = {
    repository,
    issueNumber,
    body,
    token,
    authorLogin,
    fetchImpl,
  };
  const invalidInputs = [
    { name: "empty body", input: { ...valid, body: "" }, pattern: /body|marker/i },
    {
      name: "body without marker",
      input: { ...valid, body: "## Explore report" },
      pattern: /body|marker/i,
    },
    {
      name: "marker after leading whitespace",
      input: { ...valid, body: ` ${body}` },
      pattern: /begin|start|marker/i,
    },
    { name: "empty repository", input: { ...valid, repository: "" }, pattern: /repository/i },
    { name: "owner only", input: { ...valid, repository: "acme" }, pattern: /repository/i },
    {
      name: "extra repository segment",
      input: { ...valid, repository: "acme/mobile/app" },
      pattern: /repository/i,
    },
    { name: "zero issue", input: { ...valid, issueNumber: 0 }, pattern: /issue/i },
    { name: "negative issue", input: { ...valid, issueNumber: -1 }, pattern: /issue/i },
    { name: "fractional issue", input: { ...valid, issueNumber: 1.5 }, pattern: /issue/i },
    { name: "string issue", input: { ...valid, issueNumber: "42" }, pattern: /issue/i },
    {
      name: "insecure public API URL",
      input: { ...valid, apiUrl: "http://api.github.com/" },
      pattern: /apiUrl|https/i,
    },
    {
      name: "custom API without an explicit trusted origin",
      input: { ...valid, apiUrl: "https://github.example/api/v3/" },
      pattern: /trustedApiOrigin/i,
    },
    {
      name: "custom API with a different trusted origin",
      input: {
        ...valid,
        apiUrl: "https://attacker.example/api/v3/",
        trustedApiOrigin: "https://github.example",
      },
      pattern: /origin|trustedApiOrigin/i,
    },
    {
      name: "trusted origin containing a path",
      input: {
        ...valid,
        apiUrl: "https://github.example/api/v3/",
        trustedApiOrigin: "https://github.example/api/v3/",
      },
      pattern: /origin/i,
    },
    {
      name: "zero request timeout",
      input: { ...valid, requestTimeoutMs: 0 },
      pattern: /requestTimeoutMs/i,
    },
    {
      name: "excessive request timeout",
      input: { ...valid, requestTimeoutMs: 60_001 },
      pattern: /requestTimeoutMs/i,
    },
  ];

  for (const { name, input, pattern } of invalidInputs) {
    await assert.rejects(upsertStickyComment(input), pattern, name);
  }
  assert.equal(requestCount, 0);
});
